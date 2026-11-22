import Foundation

/// What `wizards-bot pair` printed: `--json` from 0.2 on, the lines `Address:` and `Code:` before.
nonisolated enum PairOutput {
    static func read(_ output: String) -> (address: String?, code: String)? {
        if let start = output.firstIndex(of: "{"),
           let data = String(output[start...]).data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let code = json["code"] as? String
        {
            return (json["address"] as? String, code)
        }
        var address: String?
        var code: String?
        for line in output.split(whereSeparator: \.isNewline) {
            let text = line.trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("Address:") { address = value(text) }
            if text.hasPrefix("Code:") { code = value(text) }
        }
        guard let code, !Address.tidy(code).isEmpty else { return nil }
        return (address, code)
    }

    private static func value(_ line: String) -> String {
        String(line.drop { $0 != ":" }.dropFirst()).trimmingCharacters(in: .whitespaces)
    }
}

/// A login shell's `PATH`, as `$SHELL -lic 'echo …'` prints it between two marks, so what the
/// shell's start files print around it does not get in.
nonisolated enum ShellPath {
    static let mark = "__WIZARDS_PATH__"

    static func read(_ output: String) -> String? {
        let parts = output.components(separatedBy: mark)
        guard parts.count >= 3 else { return nil }
        let path = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
        let folders = path.split(separator: ":").map(String.init).filter { $0.hasPrefix("/") }
        guard !folders.isEmpty else { return nil }
        var seen = Set<String>()
        return folders.filter { seen.insert($0).inserted }.joined(separator: ":")
    }
}
