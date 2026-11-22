import Contacts
import EventKit
import Foundation

/// A calendar entry as the phone's agent reads it.
nonisolated struct PhoneEvent: Hashable, Sendable {
    var id: String
    var title: String
    var start: Date
    var end: Date
    var allDay: Bool
    var calendar: String
    var location: String?
    /// False for an entry of a calendar this phone may not change, e.g. a subscribed one.
    var changeable = true
}

/// A reminder as the phone's agent reads it.
nonisolated struct PhoneReminder: Hashable, Sendable {
    var id: String
    var title: String
    var due: Date?
    var done: Bool
    var list: String
}

/// A contact as the phone's agent reads it: what it needs to answer, nothing else.
nonisolated struct PhoneContact: Hashable, Sendable {
    var name: String
    var organization: String?
    var phones: [String]
    var emails: [String]
    var birthday: DateComponents?
}

/// Whether the person let this app use something the phone keeps.
nonisolated enum PhoneAccess: Sendable, Equatable {
    case allowed
    /// The person was not asked yet; the phone asks when an agent first needs it.
    case notAsked
    /// The person said no, or only allowed adding; it can be changed in Settings.
    case denied
}

/// The kinds of what the phone keeps that its agent reads through the system.
nonisolated enum PhoneStore: String, Sendable, CaseIterable {
    case calendar, reminders, contacts
}

/// What the phone keeps, as its agent reaches it. The app reads it through EventKit and Contacts;
/// tests give one of their own.
nonisolated protocol PhoneData: Sendable {
    func access(_ store: PhoneStore) -> PhoneAccess
    /// Shows the system's question when the person was not asked yet. True when allowed.
    func requestAccess(_ store: PhoneStore) async -> Bool
    func events(from start: Date, to end: Date) async throws -> [PhoneEvent]
    func addEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?) async throws -> PhoneEvent
    func changeEvent(id: String, title: String?, start: Date?, end: Date?, location: String?) async throws -> PhoneEvent
    func removeEvent(id: String) async throws
    func reminders(done: Bool) async throws -> [PhoneReminder]
    func addReminder(title: String, due: Date?) async throws -> PhoneReminder
    func changeReminder(id: String, title: String?, due: Date??, done: Bool?) async throws -> PhoneReminder
    func contacts(matching name: String) async throws -> [PhoneContact]
}

/// What went wrong while reading or changing what the phone keeps, as a sentence for the model.
nonisolated struct PhoneDataProblem: Error, Equatable {
    var sentence: String
}

/// The phone's calendar, reminders and contacts through EventKit and Contacts.
nonisolated final class SystemPhoneData: PhoneData, @unchecked Sendable {
    // EventKit's store is safe to use from any thread; one instance serves the app.
    private let events = EKEventStore()
    private let people = CNContactStore()

    func access(_ store: PhoneStore) -> PhoneAccess {
        switch store {
        case .calendar: Self.access(EKEventStore.authorizationStatus(for: .event))
        case .reminders: Self.access(EKEventStore.authorizationStatus(for: .reminder))
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .authorized, .limited: .allowed
            case .notDetermined: .notAsked
            default: .denied
            }
        }
    }

    private static func access(_ status: EKAuthorizationStatus) -> PhoneAccess {
        switch status {
        case .fullAccess: .allowed
        case .notDetermined: .notAsked
        default: .denied
        }
    }

    func requestAccess(_ store: PhoneStore) async -> Bool {
        do {
            switch store {
            case .calendar: return try await events.requestFullAccessToEvents()
            case .reminders: return try await events.requestFullAccessToReminders()
            case .contacts: return try await people.requestAccess(for: .contacts)
            }
        } catch {
            return false
        }
    }

    func events(from start: Date, to end: Date) async throws -> [PhoneEvent] {
        let predicate = events.predicateForEvents(withStart: start, end: end, calendars: nil)
        return events.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .map(Self.event)
    }

    func addEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?) async throws -> PhoneEvent {
        guard let calendar = events.defaultCalendarForNewEvents else {
            throw PhoneDataProblem(sentence: "This phone has no calendar for new entries.")
        }
        let event = EKEvent(eventStore: events)
        event.calendar = calendar
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = allDay
        event.location = location
        try events.save(event, span: .thisEvent, commit: true)
        return Self.event(event)
    }

    func changeEvent(id: String, title: String?, start: Date?, end: Date?, location: String?) async throws -> PhoneEvent {
        guard let event = events.event(withIdentifier: id) else { throw PhoneDataProblem(sentence: "That entry is not in the calendar any more.") }
        if let title { event.title = title }
        if let start {
            let length = event.endDate.timeIntervalSince(event.startDate)
            event.startDate = start
            if end == nil { event.endDate = start.addingTimeInterval(length) }
        }
        if let end { event.endDate = end }
        if let location { event.location = location.isEmpty ? nil : location }
        try events.save(event, span: .thisEvent, commit: true)
        return Self.event(event)
    }

    func removeEvent(id: String) async throws {
        guard let event = events.event(withIdentifier: id) else { return }
        try events.remove(event, span: .thisEvent, commit: true)
    }

    func reminders(done: Bool) async throws -> [PhoneReminder] {
        let predicate = done
            ? events.predicateForCompletedReminders(withCompletionDateStarting: Date.now.addingTimeInterval(-30 * 86_400), ending: nil, calendars: nil)
            : events.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let store = events
        let found: [PhoneReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: ($0 ?? []).map(Self.reminder)) }
        }
        return found.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
    }

    func addReminder(title: String, due: Date?) async throws -> PhoneReminder {
        guard let list = events.defaultCalendarForNewReminders() else {
            throw PhoneDataProblem(sentence: "This phone has no list for new reminders.")
        }
        let reminder = EKReminder(eventStore: events)
        reminder.calendar = list
        reminder.title = title
        reminder.dueDateComponents = due.map(Self.components)
        try events.save(reminder, commit: true)
        return Self.reminder(reminder)
    }

    func changeReminder(id: String, title: String?, due: Date??, done: Bool?) async throws -> PhoneReminder {
        guard let reminder = events.calendarItem(withIdentifier: id) as? EKReminder else {
            throw PhoneDataProblem(sentence: "That reminder is not there any more.")
        }
        if let title { reminder.title = title }
        if let due { reminder.dueDateComponents = due.map(Self.components) }
        if let done { reminder.isCompleted = done }
        try events.save(reminder, commit: true)
        return Self.reminder(reminder)
    }

    func contacts(matching name: String) async throws -> [PhoneContact] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        let found = try people.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)
        return found.map { contact in
            PhoneContact(
                name: CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName,
                organization: contact.organizationName.isEmpty ? nil : contact.organizationName,
                phones: contact.phoneNumbers.map(\.value.stringValue),
                emails: contact.emailAddresses.map { $0.value as String },
                birthday: contact.birthday
            )
        }
    }

    private static func event(_ event: EKEvent) -> PhoneEvent {
        PhoneEvent(
            id: event.eventIdentifier ?? "", title: event.title ?? "", start: event.startDate, end: event.endDate,
            allDay: event.isAllDay, calendar: event.calendar?.title ?? "",
            location: event.location?.isEmpty == false ? event.location : nil,
            changeable: event.calendar?.allowsContentModifications ?? false
        )
    }

    private static func reminder(_ reminder: EKReminder) -> PhoneReminder {
        PhoneReminder(
            id: reminder.calendarItemIdentifier, title: reminder.title ?? "",
            due: reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) },
            done: reminder.isCompleted, list: reminder.calendar?.title ?? ""
        )
    }

    private static func components(_ date: Date) -> DateComponents {
        Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    }
}
