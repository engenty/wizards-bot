import Foundation
import Security

/// Small values this device must keep to itself: the home's address and the token it gave.
nonisolated enum Keychain {
    private static let service = "bot.wizards"

    static func save<Value: Encodable>(_ value: Value, as account: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        // Readable after the first unlock, so a notification can be answered from the lock screen.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func read<Value: Decodable>(_ type: Value.Type, from account: String) -> Value? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func remove(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

nonisolated extension HomeLink {
    private static let account = "home"

    /// The home this device is paired with, if any.
    static var stored: HomeLink? { Keychain.read(HomeLink.self, from: account) }

    func store() { Keychain.save(self, as: Self.account) }

    static func forget() { Keychain.remove(account) }
}
