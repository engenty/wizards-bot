import CryptoKit
import Foundation
import Security

/// The prints a home's https on the person's network is trusted by (docs/protocol.md, "On the
/// person's network"). No one signs that certificate: an address with a print here is trusted
/// when the key it answers with has that print, and refused otherwise. Every other address is
/// checked the usual way.
nonisolated final class HomeTrust: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = HomeTrust()

    private let lock = NSLock()
    /// `host:port` → print.
    private var prints: [String: String] = [:]

    /// Trusts `print` for the https at `url`'s host and port.
    func trust(_ print: String, at url: URL) {
        guard url.scheme?.lowercased() == "https", let key = Self.key(url.host(), url.port ?? 443) else { return }
        lock.withLock { prints[key] = print }
    }

    func print(host: String, port: Int) -> String? {
        guard let key = Self.key(host, port) else { return nil }
        return lock.withLock { prints[key] }
    }

    /// The answer to a challenge: an address with a print is trusted by it alone.
    func answer(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let expected = print(host: space.host, port: space.port) else { return (.performDefaultHandling, nil) }
        guard let trust = space.serverTrust, Self.print(of: trust) == expected else {
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    /// A streamed load (`bytes(for:)`) asks its task, not its session.
    func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    /// The print of the key a server answered with: SHA-256 of its public half (SPKI, DER),
    /// base64url. A home's key is EC P-256; any other key has none.
    static func print(of trust: SecTrust) -> String? {
        guard let certificate = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
              attributes[kSecAttrKeySizeInBits] as? Int == 256,
              let point = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return nil }
        return print(ofP256Point: point)
    }

    /// The SPKI print of an uncompressed P-256 point (`04 || x || y`).
    static func print(ofP256Point point: Data) -> String? {
        guard point.count == 65 else { return nil }
        let digest = SHA256.hash(data: p256Header + point)
        return Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// What comes before the point in an EC P-256 SPKI: the algorithm, the curve, the bit string.
    private static let p256Header = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08,
        0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])

    private static func key(_ host: String?, _ port: Int) -> String? {
        guard let host, !host.isEmpty else { return nil }
        return "\(host.lowercased()):\(port)"
    }
}

nonisolated extension HomeLink {
    /// This link's address over https, when it is http on the person's network.
    var secureAddress: URL? {
        guard baseURL.scheme?.lowercased() == "http", let host = baseURL.host(),
              HomeAddress.isLocal(host), var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        else { return nil }
        // The port stays: the home answers http and https on the same one.
        if parts.port == nil { parts.port = 80 }
        parts.scheme = "https"
        return parts.url
    }
}
