import Foundation
import Testing

/// What the phone keeps, made up for a test: a calendar, reminders and contacts in memory.
nonisolated final class FakePhoneData: PhoneData, @unchecked Sendable {
    private let lock = NSLock()
    var accessOf: [PhoneStore: PhoneAccess] = [.calendar: .allowed, .reminders: .allowed, .contacts: .allowed]
    var grants = true
    var asked: [PhoneStore] = []
    var events: [PhoneEvent] = []
    var reminderList: [PhoneReminder] = []
    var people: [PhoneContact] = []

    func access(_ store: PhoneStore) -> PhoneAccess { lock.withLock { accessOf[store] ?? .denied } }

    func requestAccess(_ store: PhoneStore) async -> Bool {
        lock.withLock {
            asked.append(store)
            accessOf[store] = grants ? .allowed : .denied
            return grants
        }
    }

    func events(from start: Date, to end: Date) async throws -> [PhoneEvent] {
        lock.withLock { events.filter { $0.end > start && $0.start < end }.sorted { $0.start < $1.start } }
    }

    func addEvent(title: String, start: Date, end: Date, allDay: Bool, location: String?) async throws -> PhoneEvent {
        lock.withLock {
            let event = PhoneEvent(id: "EV-\(events.count + 1)-LONG-IDENTIFIER", title: title, start: start, end: end, allDay: allDay, calendar: "Home", location: location)
            events.append(event)
            return event
        }
    }

    func changeEvent(id: String, title: String?, start: Date?, end: Date?, location: String?) async throws -> PhoneEvent {
        try lock.withLock {
            guard let index = events.firstIndex(where: { $0.id == id }) else { throw PhoneDataProblem(sentence: "gone") }
            if let title { events[index].title = title }
            if let start { events[index].start = start }
            if let end { events[index].end = end }
            if let location { events[index].location = location.isEmpty ? nil : location }
            return events[index]
        }
    }

    func removeEvent(id: String) async throws {
        lock.withLock { events.removeAll { $0.id == id } }
    }

    func reminders(done: Bool) async throws -> [PhoneReminder] {
        lock.withLock { reminderList.filter { $0.done == done } }
    }

    func addReminder(title: String, due: Date?) async throws -> PhoneReminder {
        lock.withLock {
            let reminder = PhoneReminder(id: "RM-\(reminderList.count + 1)", title: title, due: due, done: false, list: "Reminders")
            reminderList.append(reminder)
            return reminder
        }
    }

    func changeReminder(id: String, title: String?, due: Date??, done: Bool?) async throws -> PhoneReminder {
        try lock.withLock {
            guard let index = reminderList.firstIndex(where: { $0.id == id }) else { throw PhoneDataProblem(sentence: "gone") }
            if let title { reminderList[index].title = title }
            if let due { reminderList[index].due = due }
            if let done { reminderList[index].done = done }
            return reminderList[index]
        }
    }

    func contacts(matching name: String) async throws -> [PhoneContact] {
        lock.withLock { people.filter { $0.name.localizedCaseInsensitiveContains(name) } }
    }
}

/// The questions put to the person, answered the way a test says.
nonisolated final class Person: @unchecked Sendable {
    private let lock = NSLock()
    var says = true
    private(set) var questions: [PhoneQuestion] = []

    func ask(_ question: PhoneQuestion) -> Bool {
        lock.withLock {
            questions.append(question)
            return says
        }
    }
}

/// The phone's agent reads what the phone keeps and passes on short answers; it changes and sends
/// nothing without the person's yes.
@Suite struct PhoneToolsTests {
    nonisolated static let vienna: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Vienna")!
        return calendar
    }()

    /// Monday 23 November 2026, 09:00 in Vienna.
    nonisolated static let monday = vienna.date(from: DateComponents(year: 2026, month: 11, day: 23, hour: 9))!

    nonisolated static func at(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        vienna.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour, minute: minute))!
    }

    func tools(_ data: FakePhoneData, _ person: Person = Person(), folders: [PhoneFolder] = [],
               upload: (@Sendable (URL) async throws -> FileRef)? = nil) -> PhoneTools {
        PhoneTools(data: data, folders: folders, ask: { person.ask($0) }, upload: upload, now: { Self.monday }, calendar: Self.vienna)
    }

    @Test func theCalendarIsReadShortWithNamesForEachEntry() async {
        let data = FakePhoneData()
        data.events = [
            PhoneEvent(id: "A-VERY-LONG-ID", title: "Dentist", start: Self.at(24, 10), end: Self.at(24, 11), allDay: false, calendar: "Home", location: "Praxis Berg"),
            PhoneEvent(id: "B", title: "Trip", start: Self.at(25, 0), end: Self.at(27, 0), allDay: true, calendar: "Home"),
            PhoneEvent(id: "C", title: "Lunch", start: Self.at(23, 12), end: Self.at(23, 13), allDay: false, calendar: "Work"),
        ]
        let phone = tools(data)
        let tomorrow = await phone.calendarRead(fromDay: 1, days: 1, search: nil)
        #expect(tomorrow == "Tue 24 Nov:\ne1 Tue 24 Nov 10:00–11:00 Dentist @ Praxis Berg")
        #expect(!tomorrow.contains("A-VERY-LONG-ID"))
        let week = await phone.calendarRead(fromDay: 0, days: 7, search: nil)
        #expect(week.hasPrefix("Mon 23 Nov to Sun 29 Nov:\ne2 Mon 23 Nov 12:00–13:00 Lunch\ne1 Tue 24 Nov"))
        #expect(week.contains("e3 Wed 25 Nov to Thu 26 Nov all day Trip"))
        #expect(await phone.calendarRead(fromDay: 0, days: 7, search: "dentist").components(separatedBy: "\n").count == 2)
        #expect(await phone.calendarRead(fromDay: 10, days: 1, search: nil) == "Nothing in the calendar Thu 3 Dec.")
    }

    @Test func aLongCalendarIsCut() async {
        let data = FakePhoneData()
        data.events = (0 ..< 20).map { index in
            PhoneEvent(id: "\(index)", title: "Call \(index)", start: Self.at(24, 8).addingTimeInterval(Double(index) * 1800),
                       end: Self.at(24, 8).addingTimeInterval(Double(index) * 1800 + 900), allDay: false, calendar: "Work")
        }
        let answer = await tools(data).calendarRead(fromDay: 1, days: 1, search: nil)
        #expect(answer.components(separatedBy: "\n").count == 1 + PhoneTools.lineLimit + 1)
        #expect(answer.hasSuffix("(5 more; ask for fewer days or search)"))
    }

    @Test func anEntryIsAddedOnlyAfterTheYes() async {
        let data = FakePhoneData()
        let person = Person()
        person.says = false
        let phone = tools(data, person)
        let refused = await phone.calendarChange(ref: nil, title: "Dentist", date: "2026-11-24", time: "10:00", minutes: 45, location: nil, remove: false)
        #expect(refused == PhoneTools.saidNo)
        #expect(data.events.isEmpty)
        #expect(person.questions.first?.detail.contains("Dentist") == true)
        person.says = true
        let added = await phone.calendarChange(ref: nil, title: "Dentist", date: "tomorrow", time: "10:00", minutes: 45, location: nil, remove: false)
        #expect(added == "Added as e1: Tue 24 Nov 10:00–10:45 Dentist.")
        #expect(data.events.first?.end == Self.at(24, 10, 45))
        #expect(await phone.changed == ["Added Dentist: Tue 24 Nov 10:00–10:45"])
        // An entry with no time lasts the whole day.
        _ = await phone.calendarChange(ref: nil, title: "Holiday", date: "2026-11-27", time: nil, minutes: nil, location: nil, remove: false)
        #expect(data.events.last?.allDay == true)
        #expect(await phone.calendarChange(ref: nil, title: "X", date: "next week", time: nil, minutes: nil, location: nil, remove: false)
            == "A new entry needs a date, like 2026-11-24.")
    }

    @Test func anEntryIsChangedOrRemovedByTheNameTheModelSaw() async {
        let data = FakePhoneData()
        data.events = [PhoneEvent(id: "LONG", title: "Dentist", start: Self.at(24, 10), end: Self.at(24, 11), allDay: false, calendar: "Home")]
        let person = Person()
        let phone = tools(data, person)
        #expect(await phone.calendarChange(ref: "e1", title: nil, date: nil, time: "14:00", minutes: nil, location: nil, remove: false)
            .hasPrefix("There is no entry e1"))
        _ = await phone.calendarRead(fromDay: 1, days: 1, search: nil)
        let moved = await phone.calendarChange(ref: "e1", title: nil, date: nil, time: "14:00", minutes: nil, location: nil, remove: false)
        #expect(moved == "Changed: Tue 24 Nov 14:00–15:00 Dentist.")
        #expect(person.questions.last?.detail.contains("→") == true)
        _ = await phone.calendarChange(ref: "e1", title: nil, date: nil, time: nil, minutes: nil, location: nil, remove: true)
        #expect(data.events.isEmpty)
        #expect(person.questions.count == 2)
    }

    @Test func aCalendarThatCantBeChangedSaysSo() async {
        let data = FakePhoneData()
        var holiday = PhoneEvent(id: "H", title: "National holiday", start: Self.at(24, 0), end: Self.at(25, 0), allDay: true, calendar: "Holidays")
        holiday.changeable = false
        data.events = [holiday]
        let person = Person()
        let phone = tools(data, person)
        _ = await phone.calendarRead(fromDay: 1, days: 1, search: nil)
        #expect(await phone.calendarChange(ref: "e1", title: "Off", date: nil, time: nil, minutes: nil, location: nil, remove: false)
            == "The calendar Holidays can't be changed from this phone.")
        #expect(person.questions.isEmpty)
    }

    @Test func whatThePersonDidNotAllowIsNotRead() async {
        let data = FakePhoneData()
        data.accessOf[.contacts] = .denied
        data.accessOf[.reminders] = .notAsked
        data.grants = false
        let phone = tools(data)
        #expect(await phone.contacts(name: "Anna").hasPrefix("The person has not let this app use the contacts"))
        #expect(data.asked.isEmpty)
        // Not asked yet: the phone asks now.
        #expect(await phone.remindersRead(done: false, search: nil).hasPrefix("The person has not let this app use the reminders"))
        #expect(data.asked == [.reminders])
        #expect(!phone.offers(.contacts))
        #expect(phone.offers(.calendar))
    }

    @Test func remindersAreReadAndTickedOff() async {
        let data = FakePhoneData()
        data.reminderList = [
            PhoneReminder(id: "R1", title: "Milk", due: nil, done: false, list: "Shopping"),
            PhoneReminder(id: "R2", title: "Call Anna", due: Self.at(24, 18), done: false, list: "Reminders"),
            PhoneReminder(id: "R3", title: "Old", due: nil, done: true, list: "Reminders"),
        ]
        let person = Person()
        let phone = tools(data, person)
        #expect(await phone.remindersRead(done: false, search: nil) == "r1 Milk (Shopping)\nr2 Call Anna, due Tue 24 Nov 18:00 (Reminders)")
        let ticked = await phone.reminderChange(ref: "r1", title: nil, date: nil, time: nil, done: true)
        #expect(ticked == "Changed: Milk, done.")
        #expect(person.questions.last?.title == String(localized: "Tick off this reminder?"))
        let added = await phone.reminderChange(ref: nil, title: "Pay rent", date: "2026-12-01", time: "09:00", done: nil)
        #expect(added == "Added as r3: Pay rent, due Tue 1 Dec 09:00.")
    }

    @Test func contactsAnswerWithWhatIsAskedFor() async {
        let data = FakePhoneData()
        data.people = [PhoneContact(name: "Anna Berg", organization: "Berg & Co", phones: ["+43 660 1", "+43 1 2", "+43 1 3"], emails: ["anna@berg.at"],
                                    birthday: DateComponents(month: 3, day: 3))]
        data.people += (1 ... 6).map { PhoneContact(name: "Anna \($0)", organization: nil, phones: [], emails: [], birthday: nil) }
        let answer = await tools(data).contacts(name: "anna")
        let lines = answer.components(separatedBy: "\n")
        #expect(lines.first == "Anna Berg (Berg & Co), +43 660 1, +43 1 2, anna@berg.at, birthday 3 March")
        #expect(lines.count == 6)
        #expect(lines.last == "(2 more; give more of the name)")
    }
}

/// Folders connected on the phone: read in place, never outside the folder, sent only after a yes.
@Suite struct PhoneFolderTests {
    func folder() throws -> (PhoneFolder, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "phone-folder-\(UUID().uuidString)/Receipts")
        let outside = root.deletingLastPathComponent().appending(path: "outside")
        try FileManager.default.createDirectory(at: root.appending(path: "2026"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("Hotel Kraków 180 EUR".utf8).write(to: root.appending(path: "2026/hotel.txt"))
        try Data(String(repeating: "Line of a long note.\n", count: 200).utf8).write(to: root.appending(path: "notes.md"))
        try Data([0, 1, 2, 3]).write(to: root.appending(path: "photo.bin"))
        try Data("hidden".utf8).write(to: root.appending(path: ".secret"))
        try Data("not yours".utf8).write(to: outside.appending(path: "private.txt"))
        try FileManager.default.createSymbolicLink(at: root.appending(path: "link"), withDestinationURL: outside)
        let store = PhoneFolders(file: root.deletingLastPathComponent().appending(path: "folders.json"))
        let connected = try store.connect(root)
        return (connected, root, outside)
    }

    @Test func aFolderIsKeptOnThePhoneWithANameOfItsOwn() throws {
        let (connected, root, _) = try folder()
        #expect(connected.name == "Receipts")
        let store = PhoneFolders(file: root.deletingLastPathComponent().appending(path: "folders.json"))
        #expect(store.folders.map(\.name) == ["Receipts"])
        #expect(try store.connect(root).name == "Receipts 2")
        store.disconnect(connected.id)
        #expect(PhoneFolders(file: root.deletingLastPathComponent().appending(path: "folders.json")).folders.map(\.name) == ["Receipts 2"])
        let count = PhoneFolderReader.count(root)
        #expect(count.files == 3)
        #expect(count.folders == 1)
        #expect(!count.more)
    }

    @Test func theAgentListsSearchesAndReadsInParts() async throws {
        let (connected, _, _) = try folder()
        let phone = PhoneTools(data: FakePhoneData(), folders: [connected], ask: { _ in true })
        #expect(await phone.files(folder: nil, path: nil, search: nil, part: nil) == "Folders on this phone: Receipts.")
        #expect(await phone.files(folder: "receipts", path: nil, search: nil, part: nil) == "Receipts:\n2026/\n2026/hotel.txt\nnotes.md\nphoto.bin")
        #expect(await phone.files(folder: "Receipts", path: nil, search: "HOTEL", part: nil) == "2026/hotel.txt")
        #expect(await phone.files(folder: "Receipts", path: "2026/hotel.txt", search: nil, part: nil) == "2026/hotel.txt:\nHotel Kraków 180 EUR")
        let first = await phone.files(folder: "Receipts", path: "notes.md", search: nil, part: nil)
        #expect(first.hasPrefix("notes.md, part 1 of 3:\n"))
        #expect(first.count < PhoneTools.readLimit + 40)
        #expect(await phone.files(folder: "Receipts", path: "notes.md", search: nil, part: 3).hasPrefix("notes.md, part 3 of 3:"))
        #expect(await phone.files(folder: "Receipts", path: "photo.bin", search: nil, part: nil).contains("has no text"))
        #expect(await phone.files(folder: "Trips", path: nil, search: nil, part: nil) == "No folder is called Trips. Folders: Receipts.")
    }

    @Test func nothingOutsideTheFolderNothingHidden() async throws {
        let (connected, root, _) = try folder()
        let phone = PhoneTools(data: FakePhoneData(), folders: [connected], ask: { _ in true })
        for path in ["../outside/private.txt", ".secret", "link/private.txt", "2026/../../outside/private.txt", "/etc/hosts"] {
            #expect(await phone.files(folder: "Receipts", path: path, search: nil, part: nil).hasPrefix("There is no file"), "\(path)")
            #expect(PhoneFolderReader.locate(path, in: root) == nil, "\(path)")
        }
        let listed = await phone.files(folder: "Receipts", path: nil, search: nil, part: nil)
        #expect(!listed.contains("secret") && !listed.contains("private"))
    }

    @Test func aFileLeavesThePhoneOnlyAfterTheYes() async throws {
        let (connected, _, _) = try folder()
        let person = Person()
        person.says = false
        let uploaded = Person()
        let phone = PhoneTools(
            data: FakePhoneData(), folders: [connected], ask: { person.ask($0) },
            upload: { url in
                _ = uploaded.ask(PhoneQuestion(title: url.lastPathComponent, detail: "", yes: "", no: ""))
                return FileRef(id: "fil_1", name: url.lastPathComponent, mime: "text/plain", size: 20)
            }
        )
        #expect(await phone.sendFile(folder: "Receipts", path: "2026/hotel.txt", asker: "Goose") == PhoneTools.saidNo)
        #expect(uploaded.questions.isEmpty)
        #expect(person.questions.first?.detail.contains("Goose") == true)
        person.says = true
        #expect(await phone.sendFile(folder: "Receipts", path: "2026/hotel.txt", asker: "Goose") == "Sent hotel.txt. It goes with your answer.")
        #expect(uploaded.questions.map(\.title) == ["hotel.txt"])
        #expect(await phone.sent.map(\.id) == ["fil_1"])
        #expect(await phone.sendFile(folder: "Receipts", path: "../outside/private.txt", asker: "Goose").hasPrefix("There is no file"))
        // A conversation on the phone sends nothing anywhere.
        let local = PhoneTools(data: FakePhoneData(), folders: [connected], ask: { _ in true })
        #expect(await local.sendFile(folder: "Receipts", path: "2026/hotel.txt", asker: "Goose") == "Nothing leaves this phone from here.")
        #expect(!local.canSend)
    }
}

/// A call or a message from a card: the phone finds the recipient in its own contacts, and the link
/// it opens carries what the agent wrote.
@Suite struct PhoneActionTests {
    @Test func theCardsLinkIsReadBack() throws {
        let call = try #require(PhoneAction(URL(string: "wizardsbot://call?to=Anna%20Berg")!))
        #expect(call == .call(to: "Anna Berg"))
        let message = try #require(PhoneAction(URL(string: "wizardsbot://message?to=Anna&via=mail&text=Late%20today&subject=Dinner")!))
        #expect(message == .message(to: "Anna", via: .mail, text: "Late today", subject: "Dinner"))
        #expect(PhoneAction(URL(string: "wizardsbot://message?to=Anna&via=fax&text=x")!) == nil)
        // Spaces as `+` or `%20`, and a `+` of its own as `%2B`.
        #expect(PhoneAction(URL(string: "wizardsbot://call?to=Anna+Berg")!) == .call(to: "Anna Berg"))
        #expect(PhoneAction(URL(string: "wizardsbot://call?to=%2B43%20660")!) == .call(to: "+43 660"))
        #expect(PhoneAction(URL(string: "wizardsbot://pair?home=x&code=y")!) == nil)
        #expect(PhoneAction(URL(string: "https://example.com/call?to=Anna")!) == nil)
    }

    @Test func aNameIsFoundInTheContactsAndANumberIsTakenAsItIs() async {
        let data = FakePhoneData()
        data.people = [PhoneContact(name: "Anna Berg", organization: nil, phones: ["+43 660 123 45 67"], emails: ["anna@berg.at"], birthday: nil)]
        #expect(await PhoneAction.call(to: "anna").recipients(in: data).map(\.address) == ["+43 660 123 45 67"])
        #expect(await PhoneAction.message(to: "Anna", via: .mail, text: "Hi", subject: nil).recipients(in: data).map(\.address) == ["anna@berg.at"])
        #expect(await PhoneAction.call(to: "+43 1 234 56").recipients(in: data).map(\.address) == ["+43 1 234 56"])
        #expect(await PhoneAction.call(to: "Ben").recipients(in: data).isEmpty)
        data.accessOf[.contacts] = .denied
        #expect(await PhoneAction.call(to: "Anna").recipients(in: data).isEmpty)
    }

    @Test func theLinkCarriesTheText() throws {
        let anna = PhoneAction.Recipient(name: "Anna Berg", address: "+43 660 123-45", label: nil)
        #expect(PhoneAction.call(to: "Anna").link(for: anna)?.absoluteString == "tel:+4366012345")
        let whatsapp = PhoneAction.message(to: "Anna", via: .whatsapp, text: "Late & sorry", subject: nil).link(for: anna)
        #expect(whatsapp?.absoluteString == "https://wa.me/4366012345?text=Late%20%26%20sorry")
        let sms = PhoneAction.message(to: "Anna", via: .messages, text: "Late", subject: nil).link(for: anna)
        #expect(sms?.absoluteString == "sms:+4366012345&body=Late")
        let mail = PhoneAction.message(to: "Anna", via: .mail, text: "Late", subject: "Dinner")
            .link(for: PhoneAction.Recipient(name: "Anna", address: "anna@berg.at", label: nil))
        #expect(mail?.absoluteString == "mailto:anna@berg.at?subject=Dinner&body=Late")
    }
}
