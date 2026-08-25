import Darwin
import Foundation

/// Incremental JSONL aggregator.
///
/// This is the whole reason the app is cheap to run. A tracker that re-reads every
/// session transcript on each tick burns seconds of CPU and hundreds of megabytes of
/// I/O per refresh, because these directories only grow: ~500 Codex rollouts and every
/// Claude Code session ever, some of them tens of megabytes.
///
/// Instead each file is remembered by its identity (inode + creation time) along with
/// how many bytes have already been folded in. A refresh stats the directory, skips
/// every file whose size has not changed, and parses only the bytes appended since
/// last time. Steady-state cost is a directory walk plus a few kilobytes of new lines.
///
/// Results are kept as hourly buckets per model, so history is bounded by time rather
/// than by transcript volume, and the on-disk cache stays small enough to load eagerly.
actor JSONLIndex {
    struct FileState: Codable {
        var inode: UInt64
        var createdAt: Double
        var offset: UInt64
    }

    struct Cache: Codable {
        var version: Int = 3
        var files: [String: FileState] = [:]
        var buckets: [String: HourBucket] = [:]
        var lastActivity: Double?
    }

    private let name: String
    private let cacheURL: URL
    private var cache = Cache()
    private var loaded = false
    /// 4 MB keeps the working set in L2-friendly territory without syscall churn.
    private let blockSize = 4 << 20

    /// Parses one line into zero or more contributions. Returning nil skips the line.
    typealias LineParser = @Sendable (Data) -> ParsedLine?

    struct ParsedLine {
        var timestamp: Date
        var model: String
        var tokens: TokenCounts
        var costUSD: Double
        /// Distinct id for the underlying API call, so a transcript that restates the
        /// same message on resume does not get counted twice.
        var dedupeKey: String?
    }

    init(name: String) {
        self.name = name
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Doohickey", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        self.cacheURL = base.appendingPathComponent("index-\(name).json")
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: cacheURL),
              let decoded = try? JSONDecoder().decode(Cache.self, from: data),
              decoded.version == Cache().version
        else { return }
        cache = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(cache) else { return }
        try? data.write(to: cacheURL, options: .atomic)
    }

    private func fold(_ lines: [ParsedLine], into pending: inout [ParsedLine]) {
        pending.append(contentsOf: lines)
    }

    private func commit(_ lines: [ParsedLine]) {
        for parsed in lines {
            if let key = parsed.dedupeKey {
                if cache.buckets["seen:\(key)"] != nil { continue }
                // Reuse the bucket map as the dedupe set: one dictionary to persist, and
                // these markers age out on the same horizon as real buckets.
                cache.buckets["seen:\(key)"] = HourBucket(
                    hour: Int(parsed.timestamp.timeIntervalSince1970 / 3600),
                    model: "", tokens: TokenCounts(), costUSD: 0, messages: 0
                )
            }
            let hour = Int(parsed.timestamp.timeIntervalSince1970 / 3600)
            let key = "\(hour)|\(parsed.model)"
            var bucket = cache.buckets[key] ?? HourBucket(
                hour: hour, model: parsed.model, tokens: TokenCounts(), costUSD: 0, messages: 0
            )
            bucket.tokens += parsed.tokens
            bucket.costUSD += parsed.costUSD
            bucket.messages += 1
            cache.buckets[key] = bucket

            let stamp = parsed.timestamp.timeIntervalSince1970
            if stamp > (cache.lastActivity ?? 0) { cache.lastActivity = stamp }
        }
    }

    /// Forget everything and re-read from scratch on the next scan.
    func reset() {
        load()
        cache = Cache()
        save()
    }

    /// Fold any new bytes in `files` into the buckets and return the full history.
    ///
    /// `horizon` drops buckets older than itself so the cache cannot grow without end,
    /// and also skips files untouched since then — an archive directory can be tens of
    /// gigabytes, almost none of it relevant to a thirty-day view.
    ///
    /// `needles` is the other half of the cold-start cost. Transcripts are overwhelmingly
    /// message content; only a fraction of a percent of lines carry usage. Rejecting a
    /// line by substring before handing it to JSONSerialization turns a multi-minute
    /// first scan into a few seconds, because the parser never sees the other 99%.
    func scan(
        files: [URL],
        horizon: TimeInterval,
        needles: [String] = [],
        parser: @escaping LineParser
    ) -> (buckets: [HourBucket], lastActivity: Date?) {
        load()

        var seen = Set<String>()
        var dirty = false
        var sinceLastSave = 0
        let needleBytes = needles.map { Array($0.utf8) }
        let oldestUseful = Date().addingTimeInterval(-horizon)

        for url in files {
            let path = url.path
            seen.insert(path)
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                  let size = (attributes[.size] as? NSNumber)?.uint64Value
            else { continue }

            // Nothing has been appended since the horizon, so nothing inside can land in
            // a live bucket. Skip without opening it.
            if let modified = attributes[.modificationDate] as? Date, modified < oldestUseful {
                continue
            }

            let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
            let created = (attributes[.creationDate] as? Date)?.timeIntervalSince1970 ?? 0

            var state = cache.files[path] ?? FileState(inode: inode, createdAt: created, offset: 0)
            // A recycled path — log rotation, a deleted-and-rewritten transcript — is a
            // different file wearing the same name. Treat it as new rather than seeking
            // into the middle of unrelated content.
            if state.inode != inode || state.createdAt != created {
                state = FileState(inode: inode, createdAt: created, offset: 0)
            }
            // Truncated in place: same identity, fewer bytes. Start over on this one.
            if size < state.offset { state.offset = 0 }
            guard size > state.offset else {
                cache.files[path] = state
                continue
            }

            guard let handle = try? FileHandle(forReadingFrom: url) else { continue }
            defer { try? handle.close() }
            try? handle.seek(toOffset: state.offset)

            // Streamed in blocks rather than read whole: an archived rollout can be
            // hundreds of megabytes, and `readToEnd` would make every one of them
            // resident at once. `carry` holds the partial line straddling a block edge.
            var carry = [UInt8]()
            var bytesRead: UInt64 = 0
            var contributions: [ParsedLine] = []
            // Held aside until the file's byte offset is known to have advanced, so a
            // read that fails partway cannot leave counted tokens with an unmoved offset.
            var pending: [ParsedLine] = []

            while autoreleasepool(invoking: { () -> Bool in
                // Without an explicit pool the Data returned by each read is autoreleased
                // and not reclaimed until the whole scan returns — which over a 14 GB
                // archive means gigabytes of resident memory for no reason.
                guard let block = try? handle.read(upToCount: blockSize), !block.isEmpty else { return false }
                bytesRead += UInt64(block.count)

                // Fast path: nothing left over from the previous block, so this one is
                // scanned where it already lives. Only a line straddling the boundary
                // causes a copy, and then only of that line.
                let scan: (UnsafeRawBufferPointer) -> Int = { buffer in
                    guard let base = buffer.baseAddress else { return 0 }
                    var lineStart = 0
                    var cursor = 0
                    while cursor < buffer.count {
                        guard let newline = memchr(base + cursor, 0x0A, buffer.count - cursor) else { break }
                        let index = UnsafeRawPointer(newline) - base
                        if index > lineStart {
                            let line = UnsafeRawBufferPointer(start: base + lineStart, count: index - lineStart)
                            if matches(line, needleBytes), let parsed = parser(Data(line)) {
                                contributions.append(parsed)
                            }
                        }
                        lineStart = index + 1
                        cursor = lineStart
                    }
                    return lineStart
                }

                if carry.isEmpty {
                    let handled = block.withUnsafeBytes(scan)
                    if handled < block.count {
                        carry.append(contentsOf: block[(block.startIndex + handled)...])
                    }
                } else {
                    var joined = carry
                    joined.append(contentsOf: block)
                    carry.removeAll(keepingCapacity: true)
                    let handled = joined.withUnsafeBufferPointer { pointer in
                        scan(UnsafeRawBufferPointer(pointer))
                    }
                    if handled < joined.count {
                        carry.append(contentsOf: joined[handled...])
                    }
                }

                // Fold as we go rather than holding every parsed line for the file.
                fold(contributions, into: &pending)
                contributions.removeAll(keepingCapacity: true)
                return true
            }) {}

            // A first scan over a large archive takes tens of seconds. Checkpointing as
            // it goes means quitting halfway costs the current file, not the whole run.
            sinceLastSave += 1
            if sinceLastSave >= 25 {
                sinceLastSave = 0
                save()
            }

            // Bytes actually folded in are everything read minus the incomplete tail
            // still sitting in `carry`. Derived this way it cannot underflow, including
            // when one line is longer than a whole block and `carry` spans several.
            let consumed = bytesRead - UInt64(carry.count)

            guard consumed > 0 || !pending.isEmpty else {
                cache.files[path] = state
                continue
            }
            state.offset += consumed
            cache.files[path] = state
            dirty = true
            commit(pending)
        }

        // Drop files that no longer exist, so the cache tracks the directory.
        let removed = cache.files.keys.filter { !seen.contains($0) }
        if !removed.isEmpty {
            for path in removed { cache.files.removeValue(forKey: path) }
            dirty = true
        }

        let cutoffHour = Int((Date().timeIntervalSince1970 - horizon) / 3600)
        let stale = cache.buckets.filter { $0.value.hour < cutoffHour }.map(\.key)
        if !stale.isEmpty {
            for key in stale { cache.buckets.removeValue(forKey: key) }
            dirty = true
        }

        if dirty { save() }

        let buckets = cache.buckets
            .filter { !$0.key.hasPrefix("seen:") }
            .values
            .sorted { $0.hour < $1.hour }
        return (buckets, cache.lastActivity.map(Date.init(timeIntervalSince1970:)))
    }
}

extension JSONLIndex {
    /// Every `.jsonl` under `root`, skipping directories the tracker has no use for.
    static func jsonlFiles(under root: URL, skipping skipped: Set<String> = []) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }

        var result: [URL] = []
        for case let url as URL in enumerator {
            if skipped.contains(url.lastPathComponent) {
                enumerator.skipDescendants()
                continue
            }
            guard url.pathExtension == "jsonl" else { continue }
            result.append(url)
        }
        return result
    }
}

/// Substring test over a raw byte range, delegating to libc's `memmem`, which is
/// vectorised. The Swift-level equivalent was measurably the hot spot: transcripts run
/// to gigabytes and almost every line is rejected here, so this call is made once per
/// line and must not allocate or bridge to String.
private func matches(_ line: UnsafeRawBufferPointer, _ needles: [[UInt8]]) -> Bool {
    guard !needles.isEmpty else { return true }
    guard let base = line.baseAddress, line.count > 0 else { return false }
    for needle in needles {
        let found = needle.withUnsafeBufferPointer { pattern -> Bool in
            guard let start = pattern.baseAddress else { return false }
            return memmem(base, line.count, start, pattern.count) != nil
        }
        if found { return true }
    }
    return false
}
