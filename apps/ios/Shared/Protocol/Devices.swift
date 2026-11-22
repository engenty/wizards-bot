import Foundation

/// What a device keeps and offers its agents. The home knows only that it is there and what the
/// device's agent can do with it, never what it holds.
nonisolated struct DeviceResource: Codable, Hashable, Sendable, Identifiable {
    enum Kind: OpenEnum {
        case calendar, reminders, contacts, folder, connection
        case unknown(String)

        static let known: [String: Kind] = [
            "calendar": .calendar, "reminders": .reminders, "contacts": .contacts, "folder": .folder, "connection": .connection,
        ]
        var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
    }

    enum Can: OpenEnum {
        /// The device's agent may change it, after the person said yes on the device.
        case read, change
        case unknown(String)

        static let known: [String: Can] = ["read": .read, "change": .change]
        var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
    }

    var id: String
    var kind: Kind
    var name: String
    var can: [Can]
}

/// Which of the person's agents may hand questions to a device, as the person said on the device. An
/// agent in neither list may ask; the device then asks the person first.
nonisolated struct DeviceAgents: Codable, Hashable, Sendable {
    var allowed: [String]
    var refused: [String]
}

/// The body of `PUT /v1/device/resources`.
nonisolated struct DeviceResources: Codable, Hashable, Sendable {
    var resources: [DeviceResource]
    var agents: DeviceAgents? = nil
}

/// A question or a task one of the person's agents hands to the agent on this device.
nonisolated struct Handoff: Codable, Hashable, Sendable, Identifiable {
    enum State: OpenEnum {
        case open, answered, declined
        case unknown(String)

        static let known: [String: State] = ["open": .open, "answered": .answered, "declined": .declined]
        var unknownValue: String? { if case .unknown(let raw) = self { raw } else { nil } }
    }

    var id: String
    var deviceId: String
    var agentId: String
    var agentName: String
    var conversationId: String
    var text: String
    var state: State
    var answer: String?
    var files: [FileRef]?
    var createdAt: String
    var answeredAt: String?
}

/// The body of `POST /v1/handoffs/:id/answer`.
nonisolated struct AnswerHandoff: Codable, Hashable, Sendable {
    var text: String
    /// Ids of files uploaded first, after the person said yes on this device.
    var files: [String]?
    var declined: Bool?
}

nonisolated struct DevicesEnvelope: Codable, Sendable { var devices: [Device] }
nonisolated struct HandoffsEnvelope: Codable, Sendable { var handoffs: [Handoff] }
