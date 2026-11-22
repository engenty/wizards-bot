import CryptoKit
import Foundation
import Security

/// The person's own key on this device. It signs the record that says which homes speak for
/// the person, and it never goes to a home: the Keychain keeps it, in iCloud Keychain where
/// that is on, and the home gets signatures only. The recovery code is the key itself, written
/// so that a person can copy it down. It is the same code the web app shows and takes.
nonisolated enum PersonKey {
    private static let service = "bot.wizards.person"
    private static let account = "key"
    private static let keyBytes = 32
    /// Letters and digits that are not mistaken for each other when written down.
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    // MARK: The recovery code

    /// One byte that changes when a character of the code is wrong or two are swapped.
    private static func check(_ seed: Data) -> UInt8 {
        var sum = 0
        for (index, byte) in seed.enumerated() {
            sum = (sum + Int(byte) * (index + 1)) % 256
        }
        return UInt8(sum)
    }

    /// The key as a code to write down: groups of four, `7K2M-…`.
    static func code(for seed: Data) -> String {
        var bits = ""
        for byte in seed + [check(seed)] {
            let binary = String(byte, radix: 2)
            bits += String(repeating: "0", count: 8 - binary.count) + binary
        }
        var code = ""
        var start = bits.startIndex
        while start < bits.endIndex {
            let end = bits.index(start, offsetBy: 5, limitedBy: bits.endIndex) ?? bits.endIndex
            let group = String(bits[start..<end])
            let padded = group + String(repeating: "0", count: 5 - group.count)
            code.append(alphabet[Int(padded, radix: 2) ?? 0])
            start = end
        }
        return stride(from: 0, to: code.count, by: 4).map { offset in
            let from = code.index(code.startIndex, offsetBy: offset)
            let to = code.index(from, offsetBy: 4, limitedBy: code.endIndex) ?? code.endIndex
            return String(code[from..<to])
        }.joined(separator: "-")
    }

    /// The key a code stands for; nothing when the code is not one, or was copied wrongly.
    static func seed(from code: String) -> Data? {
        var bits = ""
        for character in code.uppercased() where character.isLetter || character.isNumber {
            let read: Character = character == "O" ? "0" : (character == "I" || character == "L") ? "1" : character
            guard let value = alphabet.firstIndex(of: read) else { return nil }
            let binary = String(value, radix: 2)
            bits += String(repeating: "0", count: 5 - binary.count) + binary
        }
        let needed = (keyBytes + 1) * 8
        guard bits.count >= needed, bits.count < needed + 5 else { return nil }
        var bytes: [UInt8] = []
        var start = bits.startIndex
        for _ in 0...keyBytes {
            let end = bits.index(start, offsetBy: 8)
            bytes.append(UInt8(bits[start..<end], radix: 2) ?? 0)
            start = end
        }
        let seed = Data(bytes.prefix(keyBytes))
        return check(seed) == bytes[keyBytes] ? seed : nil
    }

    // MARK: The key

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The public half of a key, as a home names it.
    static func publicKey(of seed: Data) -> String? {
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
        return base64url(key.publicKey.rawRepresentation)
    }

    /// A signature over a text, as a home checks it.
    static func sign(_ text: String, with seed: Data) -> String? {
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed),
              let signature = try? key.signature(for: Data(text.utf8))
        else { return nil }
        return base64url(signature)
    }

    // MARK: Kept on this device

    private static func query(synced: Any) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: synced,
        ]
    }

    private static func keep(_ seed: Data) -> Bool {
        SecItemDelete(query(synced: kSecAttrSynchronizableAny) as CFDictionary)
        // With iCloud Keychain it reaches the person's other devices; where that is not to be
        // had, the key is kept on this device alone.
        for synced in [true, false] {
            var item = query(synced: synced)
            item[kSecValueData as String] = seed
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            if SecItemAdd(item as CFDictionary, nil) == errSecSuccess { return true }
        }
        return false
    }

    private static var seed: Data? {
        var item = query(synced: kSecAttrSynchronizableAny)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &found) == errSecSuccess else { return nil }
        return found as? Data
    }

    /// Makes the person's key and keeps it. The code is returned this once.
    static func make() -> (publicKey: String, code: String)? {
        let key = Curve25519.Signing.PrivateKey()
        let seed = key.rawRepresentation
        guard keep(seed) else { return nil }
        return (base64url(key.publicKey.rawRepresentation), code(for: seed))
    }

    /// Brings a key back from its recovery code and keeps it. Nothing for a wrong code.
    static func bringBack(_ code: String) -> String? {
        guard let seed = seed(from: code), let publicKey = publicKey(of: seed), keep(seed) else { return nil }
        return publicKey
    }

    /// The public half of the key this device holds.
    static var held: String? { seed.flatMap(publicKey(of:)) }

    /// Signs a version of the record with the key this device holds.
    static func signWithHeld(_ payload: String) -> String? {
        seed.flatMap { sign(payload, with: $0) }
    }

    /// Forgets the key on this device. The recovery code brings it back.
    static func forget() {
        SecItemDelete(query(synced: kSecAttrSynchronizableAny) as CFDictionary)
    }
}
