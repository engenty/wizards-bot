import Foundation

/// What `GET /health` of an address said.
nonisolated enum Health: Equatable, Sendable {
    /// A Bot Server answers; `version` is there from 0.2 on.
    case home(version: String?)
    /// The address answers, but not as a Bot Server.
    case notHome
    case unreachable(Problem)

    enum Problem: Equatable, Sendable {
        case noSuchAddress, nothingListens, noAnswer, certificate, offline, other(String)
    }

    /// A Bot Server answers `{ "ok": true }`; from 0.2 on also `"home": true` and its version.
    static func read(status: Int, body: Data) -> Health {
        guard status == 200,
              let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              json["ok"] as? Bool == true
        else { return .notHome }
        if let home = json["home"] as? Bool, !home { return .notHome }
        return .home(version: json["version"] as? String)
    }

    static func problem(_ error: Error) -> Problem {
        guard let error = error as? URLError else { return .other(error.localizedDescription) }
        switch error.code {
        case .cannotFindHost, .dnsLookupFailed: return .noSuchAddress
        case .cannotConnectToHost: return .nothingListens
        case .timedOut: return .noAnswer
        case .notConnectedToInternet, .networkConnectionLost: return .offline
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .secureConnectionFailed:
            return .certificate
        default: return .other(error.localizedDescription)
        }
    }

    /// Asks an address, with a limit of `seconds`.
    static func check(_ home: URL, seconds: TimeInterval = 10) async -> Health {
        var request = URLRequest(url: home.appending(path: "health"))
        request.timeoutInterval = seconds
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (body, response) = try await URLSession.shared.data(for: request)
            return read(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: body)
        } catch {
            return .unreachable(problem(error))
        }
    }
}

/// Versions as the home's releases write them, `0.2.0`; anything after a `-` is ignored.
nonisolated enum Version {
    static func parts(_ text: String) -> [Int] {
        let core = text.split(separator: "-").first.map(String.init) ?? text
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }

    /// Whether `a` is older than `b`.
    static func older(_ a: String, than b: String) -> Bool {
        let (x, y) = (parts(a), parts(b))
        for index in 0 ..< max(x.count, y.count) {
            let (p, q) = (index < x.count ? x[index] : 0, index < y.count ? y[index] : 0)
            if p != q { return p < q }
        }
        return false
    }
}
