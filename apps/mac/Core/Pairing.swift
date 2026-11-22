import Foundation

/// What `wizards-bot pair` printed: `--json` from a newer one, the lines `Address:` and `Code:` from an earlier one.
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

/// Pairs this app with a Bot Server: `POST /v1/pair` with the code, as the web app would. The
/// app pairs itself so a code is tried once, and says plainly when it is not valid.
nonisolated enum Pair {
    enum Result: Equatable, Sendable {
        case paired(token: String)
        /// The code was used, ran out or never was one (401).
        case refused
        case problem(String)
    }

    /// `kind`: `browser` for the window, `computer` for a link that offers this Mac's models.
    static func request(_ home: URL, code: String, name: String, kind: String = "browser") -> URLRequest {
        var request = URLRequest(url: home.appending(path: "v1/pair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "name": name, "kind": kind])
        return request
    }

    static func read(status: Int, body: Data) -> Result {
        if status == 401 { return .refused }
        guard status == 200,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let token = json["token"] as? String, !token.isEmpty
        else {
            let message = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["message"] as? String
            return .problem(message ?? "HTTP \(status)")
        }
        return .paired(token: token)
    }

    static func pair(_ home: URL, code: String, name: String, kind: String = "browser") async -> Result {
        do {
            let (body, response) = try await URLSession.shared.data(for: request(home, code: code, name: name, kind: kind))
            return read(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: body)
        } catch {
            return .problem(error.localizedDescription)
        }
    }

    /// The script that hands the web app its device token once (`wizards.token`, as
    /// `apps/web/src/lib/session.ts` keeps it): not again on a reload, so a device the Bot Server
    /// removed is not brought back.
    static func tokenScript(_ token: String) -> String {
        let quoted = (try? String(data: JSONEncoder().encode(token), encoding: .utf8)) ?? "\"\""
        let once = "wizards.mac.paired." + String(token.prefix(8))
        return """
        try { if (!sessionStorage.getItem("\(once)")) { localStorage.setItem("wizards.token", \(quoted)); sessionStorage.setItem("\(once)", "1"); } } catch {}
        """
    }
}

/// This Mac's link to a Bot Server elsewhere, as `wizards-bot link` keeps it: `link.json` with
/// the address and the token, `link-state.json` with how it stands (`apps/home/src/cli.ts`).
nonisolated enum Link {
    enum State: String, Equatable, Sendable {
        case connecting, linked, away, refused
    }

    static func file(home: URL, token: String) -> Data {
        let address = home.absoluteString.hasSuffix("/") ? String(home.absoluteString.dropLast()) : home.absoluteString
        return (try? JSONSerialization.data(withJSONObject: ["home": address, "token": token], options: [.sortedKeys])) ?? Data()
    }

    /// The token in `link.json`.
    static func token(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["token"] as? String
    }

    /// Removes this Mac from the Bot Server's devices with its own token (`DELETE /v1/device`):
    /// a Bot Server removes another device only that way.
    static func removal(home: URL, token: String) -> URLRequest {
        var request = URLRequest(url: home.appending(path: "v1/device"))
        request.httpMethod = "DELETE"
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        return request
    }

    /// The address in `link.json`.
    static func home(_ data: Data) -> URL? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let home = json["home"] as? String
        else { return nil }
        return URL(string: home)
    }

    static func state(_ data: Data) -> State? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = json["state"] as? String
        else { return nil }
        return State(rawValue: state)
    }
}
