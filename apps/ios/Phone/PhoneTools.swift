import Foundation

/// A change the phone's agent wants to make, or a file it wants to send, put to the person on the
/// phone. Nothing happens without their yes.
nonisolated struct PhoneQuestion: Sendable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var detail: String
    var yes: String
    var no: String
}

/// What the phone's agent can do with what the phone keeps: read the calendar, the reminders, the
/// contacts and the folders connected on it, change calendar entries and reminders after the
/// person said yes, and send a file to the home after the person said yes. Every answer is short
/// and specific: the model on the phone reads about 4 000 tokens in all.
actor PhoneTools {
    /// Lines one answer lists at most.
    static let lineLimit = 15
    /// Characters of a file one answer gives at most.
    static let readLimit = 1500

    private let data: PhoneData
    private let folders: [PhoneFolder]
    private let connections: [PhoneConnection]
    /// Calls a tool of a connection with its arguments as JSON; returns what it answered.
    private let callTool: @Sendable (PhoneConnection, String, String) async throws -> String
    private let ask: @Sendable (PhoneQuestion) async -> Bool
    /// Sends a file to the home; nil where nothing may leave the phone (a chat on the phone).
    private let upload: (@Sendable (URL) async throws -> FileRef)?
    private let now: @Sendable () -> Date
    private let calendar: Calendar

    /// Short names for what the model saw ("e1", "r2"), so it never has to copy a long identifier.
    private var refs: [String: String] = [:]
    private var counter = 0
    /// Files sent to the home in this piece of work.
    private(set) var sent: [FileRef] = []
    /// What was changed on the phone, one line each, for the list of what was asked.
    private(set) var changed: [String] = []

    init(
        data: PhoneData, folders: [PhoneFolder], ask: @escaping @Sendable (PhoneQuestion) async -> Bool,
        upload: (@Sendable (URL) async throws -> FileRef)? = nil,
        connections: [PhoneConnection] = [],
        callTool: @escaping @Sendable (PhoneConnection, String, String) async throws -> String = { _, _, _ in "" },
        now: @escaping @Sendable () -> Date = { .now }, calendar: Calendar = .current
    ) {
        self.data = data
        self.folders = folders
        self.connections = connections
        self.callTool = callTool
        self.ask = ask
        self.upload = upload
        self.now = now
        self.calendar = calendar
    }

    /// Whether the tools for one kind of data are worth offering: not when the person said no.
    nonisolated func offers(_ store: PhoneStore) -> Bool { data.access(store) != .denied }
    nonisolated var hasFolders: Bool { !folders.isEmpty }
    nonisolated var hasConnections: Bool { !connections.isEmpty }
    nonisolated var canSend: Bool { upload != nil && !folders.isEmpty }

    // MARK: Calendar

    func calendarRead(fromDay: Int, days: Int, search: String?) async -> String {
        if let refused = await allowed(.calendar) { return refused }
        let days = min(max(days, 1), 31)
        let start = calendar.date(byAdding: .day, value: fromDay, to: calendar.startOfDay(for: now())) ?? now()
        let end = calendar.date(byAdding: .day, value: days, to: start) ?? start
        do {
            var found = try await data.events(from: start, to: end)
            if let search = search?.trimmingCharacters(in: .whitespaces), !search.isEmpty {
                found = found.filter { $0.title.localizedCaseInsensitiveContains(search) || ($0.location ?? "").localizedCaseInsensitiveContains(search) }
            }
            let span = days == 1 ? day(start) : "\(day(start)) to \(day(end.addingTimeInterval(-1)))"
            guard !found.isEmpty else { return "Nothing in the calendar \(span)\(search.map { $0.isEmpty ? "" : " for \"\($0)\"" } ?? "")." }
            let lines = found.prefix(Self.lineLimit).map { event in
                "\(shortName("e", event.id)) \(when(event))\(event.title.isEmpty ? "" : " \(event.title)")\(event.location.map { " @ \($0)" } ?? "")"
            }
            return ([span + ":"] + lines + more(found.count)).joined(separator: "\n")
        } catch {
            return sentence(error)
        }
    }

    /// Adds an entry (no `ref`), changes one (`ref` from `calendarRead`) or removes one, after the person's yes.
    func calendarChange(
        ref: String?, title: String?, date: String?, time: String?, minutes: Int?, location: String?, remove: Bool
    ) async -> String {
        if let refused = await allowed(.calendar) { return refused }
        do {
            if let ref, !ref.isEmpty {
                guard let id = refs[ref] else { return "There is no entry \(ref). Read the calendar first and use the name it gives, like e1." }
                guard let current = try await event(id) else { return "That entry is not in the calendar any more." }
                guard current.changeable else { return "The calendar \(current.calendar) can't be changed from this phone." }
                if remove {
                    let question = PhoneQuestion(
                        title: String(localized: "Remove from your calendar?"), detail: personLine(current),
                        yes: String(localized: "Remove"), no: String(localized: "Keep it")
                    )
                    guard await ask(question) else { return Self.saidNo }
                    try await data.removeEvent(id: id)
                    changed.append("Removed \(current.title)")
                    return "Removed \(current.title)."
                }
                var start: Date?
                if let date, !date.isEmpty {
                    guard let day = parseDay(date) else { return "The date \(date) is not one this phone reads. Write it like 2026-11-24." }
                    start = at(day, time: time) ?? at(day, time: clock(current.start))
                } else if let time, !time.isEmpty {
                    start = at(calendar.startOfDay(for: current.start), time: time)
                }
                let end = minutes.flatMap { minutes in (start ?? current.start).addingTimeInterval(TimeInterval(minutes * 60)) }
                var after = current
                if let title, !title.isEmpty { after.title = title }
                if let start { after.end = end ?? start.addingTimeInterval(current.end.timeIntervalSince(current.start)); after.start = start }
                else if let end { after.end = end }
                if let location { after.location = location.isEmpty ? nil : location }
                guard after != current else { return "Nothing to change: give a new title, date, time, length or place." }
                let question = PhoneQuestion(
                    title: String(localized: "Change this calendar entry?"),
                    detail: "\(personLine(current))\n→ \(personLine(after))",
                    yes: String(localized: "Change"), no: String(localized: "Don't change")
                )
                guard await ask(question) else { return Self.saidNo }
                let saved = try await data.changeEvent(
                    id: id, title: after.title == current.title ? nil : after.title,
                    start: after.start == current.start ? nil : after.start, end: after.end == current.end ? nil : after.end,
                    location: after.location == current.location ? nil : (after.location ?? "")
                )
                changed.append("Changed \(saved.title): \(when(saved))")
                return "Changed: \(when(saved)) \(saved.title)."
            }
            guard let title, !title.isEmpty else { return "A new entry needs a title." }
            guard let date, let day = parseDay(date) else { return "A new entry needs a date, like 2026-11-24." }
            let allDay = time?.isEmpty ?? true
            guard let start = allDay ? day : at(day, time: time) else { return "The time \(time ?? "") is not one this phone reads. Write it like 09:30." }
            let end = allDay
                ? calendar.date(byAdding: .day, value: 1, to: day) ?? day
                : start.addingTimeInterval(TimeInterval(min(max(minutes ?? 60, 5), 24 * 60) * 60))
            let draft = PhoneEvent(id: "", title: title, start: start, end: end, allDay: allDay, calendar: "", location: location?.isEmpty == false ? location : nil)
            let question = PhoneQuestion(
                title: String(localized: "Add to your calendar?"), detail: personLine(draft),
                yes: String(localized: "Add"), no: String(localized: "Don't add")
            )
            guard await ask(question) else { return Self.saidNo }
            let saved = try await data.addEvent(title: title, start: start, end: end, allDay: allDay, location: draft.location)
            changed.append("Added \(saved.title): \(when(saved))")
            return "Added as \(shortName("e", saved.id)): \(when(saved)) \(saved.title)."
        } catch {
            return sentence(error)
        }
    }

    // MARK: Reminders

    func remindersRead(done: Bool, search: String?) async -> String {
        if let refused = await allowed(.reminders) { return refused }
        do {
            var found = try await data.reminders(done: done)
            if let search = search?.trimmingCharacters(in: .whitespaces), !search.isEmpty {
                found = found.filter { $0.title.localizedCaseInsensitiveContains(search) || $0.list.localizedCaseInsensitiveContains(search) }
            }
            guard !found.isEmpty else { return done ? "No reminder was done in the last 30 days." : "No open reminders." }
            let lines = found.prefix(Self.lineLimit).map { reminder in
                "\(shortName("r", reminder.id)) \(reminder.title)\(reminder.due.map { ", due \(moment($0))" } ?? "") (\(reminder.list))"
            }
            return (lines + more(found.count)).joined(separator: "\n")
        } catch {
            return sentence(error)
        }
    }

    /// Adds a reminder (no `ref`) or changes one: its title, when it is due, or ticks it off.
    func reminderChange(ref: String?, title: String?, date: String?, time: String?, done: Bool?) async -> String {
        if let refused = await allowed(.reminders) { return refused }
        do {
            var due: Date?
            if let date, !date.isEmpty {
                guard let day = parseDay(date) else { return "The date \(date) is not one this phone reads. Write it like 2026-11-24." }
                due = at(day, time: time) ?? day
            }
            if let ref, !ref.isEmpty {
                let id = refs[ref]
                var current = try await data.reminders(done: false).first { $0.id == id }
                if current == nil { current = try await data.reminders(done: true).first { $0.id == id } }
                guard let id, let current else {
                    return "There is no reminder \(ref). Read the reminders first and use the name they give, like r1."
                }
                let detail = [
                    title.flatMap { $0.isEmpty ? nil : "“\(current.title)” → “\($0)”" } ?? "“\(current.title)”",
                    due.map { String(localized: "Due \($0.formatted(date: .abbreviated, time: .shortened))") },
                    done == true ? String(localized: "Done") : done == false ? String(localized: "Not done") : nil,
                ].compactMap(\.self).joined(separator: "\n")
                let question = done == true && title == nil && due == nil
                    ? PhoneQuestion(title: String(localized: "Tick off this reminder?"), detail: "“\(current.title)”", yes: String(localized: "Tick off"), no: String(localized: "Leave it"))
                    : PhoneQuestion(title: String(localized: "Change this reminder?"), detail: detail, yes: String(localized: "Change"), no: String(localized: "Don't change"))
                guard await ask(question) else { return Self.saidNo }
                let saved = try await data.changeReminder(
                    id: id, title: title?.isEmpty == false ? title : nil, due: due.map { .some($0) }, done: done
                )
                changed.append("Changed reminder \(saved.title)\(saved.done ? " (done)" : "")")
                return "Changed: \(saved.title)\(saved.done ? ", done" : "")\(saved.due.map { ", due \(moment($0))" } ?? "")."
            }
            guard let title, !title.isEmpty else { return "A new reminder needs a title." }
            let question = PhoneQuestion(
                title: String(localized: "Add a reminder?"),
                detail: "“\(title)”" + (due.map { "\n" + String(localized: "Due \($0.formatted(date: .abbreviated, time: .shortened))") } ?? ""),
                yes: String(localized: "Add"), no: String(localized: "Don't add")
            )
            guard await ask(question) else { return Self.saidNo }
            let saved = try await data.addReminder(title: title, due: due)
            changed.append("Added reminder \(saved.title)")
            return "Added as \(shortName("r", saved.id)): \(saved.title)\(saved.due.map { ", due \(moment($0))" } ?? "")."
        } catch {
            return sentence(error)
        }
    }

    // MARK: Contacts

    func contacts(name: String) async -> String {
        if let refused = await allowed(.contacts) { return refused }
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return "Give a name to look for." }
        do {
            let found = try await data.contacts(matching: name)
            guard !found.isEmpty else { return "No contact is called \(name)." }
            let lines = found.prefix(5).map { contact in
                var parts = [contact.name + (contact.organization.map { $0 == contact.name ? "" : " (\($0))" } ?? "")]
                parts += contact.phones.prefix(2) + contact.emails.prefix(2)
                if let birthday = contact.birthday, let month = birthday.month, let dayOfMonth = birthday.day {
                    parts.append("birthday \(dayOfMonth) \(Self.months[month - 1])\(birthday.year.map { " \($0)" } ?? "")")
                }
                return parts.joined(separator: ", ")
            }
            return (lines + (found.count > 5 ? ["(\(found.count - 5) more; give more of the name)"] : [])).joined(separator: "\n")
        } catch {
            return sentence(error)
        }
    }

    // MARK: Folders

    /// Without a folder: the connected folders. With one: what it holds, the files whose names hold
    /// `search`, or with `path` a part of that file's text.
    func files(folder: String?, path: String?, search: String?, part: Int?) async -> String {
        guard !folders.isEmpty else { return "No folder is connected on this phone." }
        guard let folder = folder?.trimmingCharacters(in: .whitespaces), !folder.isEmpty else {
            return "Folders on this phone: " + folders.map(\.name).joined(separator: ", ") + "."
        }
        guard let connected = folders.first(where: { $0.name.caseInsensitiveCompare(folder) == .orderedSame }) else {
            return "No folder is called \(folder). Folders: " + folders.map(\.name).joined(separator: ", ") + "."
        }
        do {
            return try PhoneFolderReader.within(connected) { root in
                if let path, !path.isEmpty {
                    guard let url = PhoneFolderReader.locate(path, in: root) else { return "There is no file \(path) in \(connected.name)." }
                    guard let text = PhoneFolderReader.text(of: url)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                        return "\(path) has no text this phone can read (only text files and PDFs)."
                    }
                    let pieces = max(1, Int((Double(text.count) / Double(Self.readLimit)).rounded(.up)))
                    let number = min(max(part ?? 1, 1), pieces)
                    let start = text.index(text.startIndex, offsetBy: (number - 1) * Self.readLimit)
                    let end = text.index(start, offsetBy: Self.readLimit, limitedBy: text.endIndex) ?? text.endIndex
                    let head = pieces > 1 ? "\(path), part \(number) of \(pieces):\n" : "\(path):\n"
                    return head + text[start ..< end]
                }
                let (entries, cut) = PhoneFolderReader.entries(of: root)
                if let search = search?.trimmingCharacters(in: .whitespaces), !search.isEmpty {
                    let hits = entries.filter { !$0.isFolder && $0.path.localizedCaseInsensitiveContains(search) }
                    guard !hits.isEmpty else { return "No file in \(connected.name) has \"\(search)\" in its name." }
                    return (hits.prefix(20).map(\.path) + (hits.count > 20 ? ["(\(hits.count - 20) more)"] : [])).joined(separator: "\n")
                }
                guard !entries.isEmpty else { return "\(connected.name) is empty." }
                let shown = entries.prefix(40).map { $0.isFolder ? "\($0.path)/" : $0.path }
                let rest = entries.count - shown.count
                return (["\(connected.name):"] + shown + (rest > 0 || cut ? ["(\(cut ? "more than " : "")\(rest) more; search by name)"] : [])).joined(separator: "\n")
            }
        } catch {
            return sentence(error)
        }
    }

    /// Sends a file of a connected folder to the home, after the person said yes. It goes with the answer.
    func sendFile(folder: String, path: String, asker: String) async -> String {
        guard let upload else { return "Nothing leaves this phone from here." }
        guard let connected = folders.first(where: { $0.name.caseInsensitiveCompare(folder) == .orderedSame }) else {
            return "No folder is called \(folder)."
        }
        do {
            let url: URL? = try PhoneFolderReader.within(connected) { root in PhoneFolderReader.locate(path, in: root) }
            guard let url else { return "There is no file \(path) in \(connected.name)." }
            let question = PhoneQuestion(
                title: String(localized: "Send “\(url.lastPathComponent)” to your Bot Server?"),
                detail: String(localized: "\(asker) asked for it. A copy is kept on your Bot Server; the file stays on this phone too."),
                yes: String(localized: "Send"), no: String(localized: "Keep it here")
            )
            guard await ask(question) else { return Self.saidNo }
            let file = try await sendScoped(url, folder: connected, upload: upload)
            sent.append(file)
            changed.append("Sent \(file.name)")
            return "Sent \(file.name). It goes with your answer."
        } catch let problem as HomeError {
            return problem.message ?? "The file could not be sent. The home is out of reach."
        } catch {
            return sentence(error)
        }
    }

    private func sendScoped(_ url: URL, folder: PhoneFolder, upload: @Sendable (URL) async throws -> FileRef) async throws -> FileRef {
        // The folder stays open while the file is read for sending.
        var stale = false
        let root = try? URL(resolvingBookmarkData: folder.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        let scoped = root?.startAccessingSecurityScopedResource() ?? false
        defer { if scoped { root?.stopAccessingSecurityScopedResource() } }
        return try await upload(url)
    }

    // MARK: Connections signed in on the phone

    /// Without a name: the connections. With one: its tools. With a tool: calls it; a tool the
    /// service does not mark as read-only asks the person first. What it answers is cut short.
    func connection(name: String?, tool: String?, arguments: String?) async -> String {
        guard !connections.isEmpty else { return "No service is connected on this phone." }
        guard let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
            return "Services on this phone: " + connections.map(\.name).joined(separator: ", ") + "."
        }
        guard let connection = connections.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) else {
            return "No service is called \(name). Services: " + connections.map(\.name).joined(separator: ", ") + "."
        }
        guard let tool = tool?.trimmingCharacters(in: .whitespaces), !tool.isEmpty else {
            let lines = connection.tools.prefix(20).map { "\($0.name)\($0.readOnly ? "" : " (changes)"): \($0.description.prefix(100)) input \($0.input.prefix(160))" }
            return ([connection.name + ":"] + lines + (connection.tools.count > 20 ? ["(\(connection.tools.count - 20) more)"] : [])).joined(separator: "\n")
        }
        guard let found = connection.tools.first(where: { $0.name == tool }) else {
            return "\(connection.name) has no tool \(tool). Ask for its tools first."
        }
        let arguments = arguments?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? arguments! : "{}"
        guard (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) is [String: Any] else {
            return "The arguments must be a JSON object, like {\"query\": \"…\"}."
        }
        if !found.readOnly {
            let question = PhoneQuestion(
                title: String(localized: "Let \(connection.name) do “\(found.name)”?"),
                detail: String(arguments.prefix(400)),
                yes: String(localized: "Allow"), no: String(localized: "Don't allow")
            )
            guard await ask(question) else { return Self.saidNo }
            changed.append("\(connection.name): \(found.name)")
        }
        do {
            let answer = try await callTool(connection, found.name, arguments)
            let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return "\(found.name) answered nothing." }
            return text.count > Self.readLimit ? String(text.prefix(Self.readLimit)) + "\n(cut short)" : text
        } catch let problem as MCPProblem {
            return problem.sentence
        } catch {
            return "\(connection.name) is out of reach."
        }
    }

    // MARK: Shared

    static let saidNo = "The person said no on the phone. Nothing was changed."
    private static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    /// Nil when the phone may read this; else the sentence that says why not.
    private func allowed(_ store: PhoneStore) async -> String? {
        switch data.access(store) {
        case .allowed: return nil
        case .notAsked: if await data.requestAccess(store) { return nil }
        case .denied: break
        }
        return "The person has not let this app use the \(store.rawValue) on this phone. They can allow it in Settings."
    }

    private func event(_ id: String) async throws -> PhoneEvent? {
        let start = calendar.date(byAdding: .year, value: -1, to: now()) ?? now()
        let end = calendar.date(byAdding: .year, value: 2, to: now()) ?? now()
        return try await data.events(from: start, to: end).first { $0.id == id }
    }

    private func shortName(_ prefix: String, _ id: String) -> String {
        if let known = refs.first(where: { $0.value == id && $0.key.hasPrefix(prefix) }) { return known.key }
        counter += 1
        let name = "\(prefix)\(counter)"
        refs[name] = id
        return name
    }

    private func more(_ count: Int) -> [String] {
        count > Self.lineLimit ? ["(\(count - Self.lineLimit) more; ask for fewer days or search)"] : []
    }

    private func sentence(_ error: Error) -> String {
        (error as? PhoneDataProblem)?.sentence ?? "That did not work on this phone."
    }

    // MARK: Dates, as the model reads and writes them

    private var english: DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        return formatter
    }

    func day(_ date: Date) -> String {
        let formatter = english
        formatter.dateFormat = "EEE d MMM"
        return formatter.string(from: date)
    }

    private func clock(_ date: Date) -> String {
        let formatter = english
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    private func moment(_ date: Date) -> String { "\(day(date)) \(clock(date))" }

    private func when(_ event: PhoneEvent) -> String {
        if event.allDay {
            let last = event.end.addingTimeInterval(-1)
            return calendar.isDate(event.start, inSameDayAs: last) ? "\(day(event.start)) all day" : "\(day(event.start)) to \(day(last)) all day"
        }
        return calendar.isDate(event.start, inSameDayAs: event.end)
            ? "\(day(event.start)) \(clock(event.start))–\(clock(event.end))"
            : "\(moment(event.start)) to \(moment(event.end))"
    }

    /// An entry as the person reads it in a question: in their own language.
    private func personLine(_ event: PhoneEvent) -> String {
        let when = event.allDay
            ? event.start.formatted(.dateTime.weekday(.wide).day().month(.wide))
            : "\(event.start.formatted(.dateTime.weekday(.wide).day().month(.wide))), \(event.start.formatted(date: .omitted, time: .shortened))–\(event.end.formatted(date: .omitted, time: .shortened))"
        return "“\(event.title)”, \(when)\(event.location.map { ", \($0)" } ?? "")"
    }

    /// "2026-11-24", or today and tomorrow in words.
    func parseDay(_ text: String) -> Date? {
        let text = text.trimmingCharacters(in: .whitespaces).lowercased()
        let today = calendar.startOfDay(for: now())
        switch text {
        case "today", "heute": return today
        case "tomorrow", "morgen": return calendar.date(byAdding: .day, value: 1, to: today)
        default: break
        }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// The day at "09:30"; nil when there is no time or it is not one.
    private func at(_ day: Date, time: String?) -> Date? {
        guard let time, !time.isEmpty else { return nil }
        let parts = time.split(separator: ":").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2, (0 ..< 24).contains(parts[0]), (0 ..< 60).contains(parts[1]) else { return nil }
        return calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: day)
    }
}
