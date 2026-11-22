import Foundation
import FoundationModels

// The phone's tools as the model on the phone calls them. Each one hands its arguments to
// `PhoneTools`, which does the work; the descriptions are short because every word of them is
// read in each turn of a small model.

nonisolated struct CalendarReadTool: Tool {
    let tools: PhoneTools
    let name = "calendar"
    let description = "Read the calendar on this phone. Each entry has a name like e1 for calendarChange."

    @Generable
    struct Arguments {
        @Guide(description: "First day: 0 today, 1 tomorrow, -1 yesterday")
        var fromDay: Int
        @Guide(description: "Number of days", .range(1 ... 31))
        var days: Int
        @Guide(description: "Words in the title, or empty for all")
        var search: String?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.calendarRead(fromDay: arguments.fromDay, days: arguments.days, search: arguments.search)
    }
}

nonisolated struct CalendarChangeTool: Tool {
    let tools: PhoneTools
    let name = "calendarChange"
    let description = "Add a calendar entry, or change or remove one by its name like e1. The person is asked first."

    @Generable
    struct Arguments {
        @Guide(description: "e1 to change or remove; empty to add")
        var entry: String?
        var title: String?
        @Guide(description: "Like 2026-11-24")
        var date: String?
        @Guide(description: "Start like 09:30; empty for all day")
        var time: String?
        @Guide(description: "Length in minutes")
        var minutes: Int?
        var location: String?
        var remove: Bool?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.calendarChange(
            ref: arguments.entry, title: arguments.title, date: arguments.date, time: arguments.time,
            minutes: arguments.minutes, location: arguments.location, remove: arguments.remove ?? false
        )
    }
}

nonisolated struct RemindersReadTool: Tool {
    let tools: PhoneTools
    let name = "reminders"
    let description = "Read the open reminders on this phone, or those done in the last 30 days. Each has a name like r1."

    @Generable
    struct Arguments {
        var done: Bool
        @Guide(description: "Words in the title or list, or empty for all")
        var search: String?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.remindersRead(done: arguments.done, search: arguments.search)
    }
}

nonisolated struct ReminderChangeTool: Tool {
    let tools: PhoneTools
    let name = "reminderChange"
    let description = "Add a reminder, or change or tick off one by its name like r1. The person is asked first."

    @Generable
    struct Arguments {
        @Guide(description: "r1 to change; empty to add")
        var reminder: String?
        var title: String?
        @Guide(description: "Due day like 2026-11-24")
        var date: String?
        @Guide(description: "Due time like 09:30")
        var time: String?
        var done: Bool?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.reminderChange(ref: arguments.reminder, title: arguments.title, date: arguments.date, time: arguments.time, done: arguments.done)
    }
}

nonisolated struct ContactsTool: Tool {
    let tools: PhoneTools
    let name = "contacts"
    let description = "Find a contact on this phone by name: phone, mail, birthday."

    @Generable
    struct Arguments {
        var name: String
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.contacts(name: arguments.name)
    }
}

nonisolated struct FilesTool: Tool {
    let tools: PhoneTools
    let name = "files"
    let description = "The folders connected on this phone. No folder: lists them. A folder: lists its files, or finds names with search. A path: reads that file's text."

    @Generable
    struct Arguments {
        var folder: String?
        @Guide(description: "A file's path in the folder, to read it")
        var path: String?
        @Guide(description: "Words in file names")
        var search: String?
        @Guide(description: "Which part of a long file, from 1")
        var part: Int?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.files(folder: arguments.folder, path: arguments.path, search: arguments.search, part: arguments.part)
    }
}

nonisolated struct SendFileTool: Tool {
    let tools: PhoneTools
    let asker: String
    let name = "sendFile"
    let description = "Send a file of a connected folder to the home, when the asking agent needs the file itself. The person is asked first."

    @Generable
    struct Arguments {
        var folder: String
        var path: String
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.sendFile(folder: arguments.folder, path: arguments.path, asker: asker)
    }
}

nonisolated struct ConnectionTool: Tool {
    let tools: PhoneTools
    let name = "connection"
    let description = "Services signed in on this phone. No name: lists them. A name: lists its tools. A tool: calls it with arguments as JSON."

    @Generable
    struct Arguments {
        var name: String?
        var tool: String?
        @Guide(description: "A JSON object, like {\"query\": \"rent\"}")
        var arguments: String?
    }

    @concurrent
    func call(arguments: Arguments) async throws -> String {
        await tools.connection(name: arguments.name, tool: arguments.tool, arguments: arguments.arguments)
    }
}

extension PhoneTools {
    /// The tools worth offering: none for what the person said no to, none for folders when none
    /// is connected, and sending only where something may leave the phone.
    nonisolated func modelTools(asker: String?) -> [any Tool] {
        var tools: [any Tool] = []
        if offers(.calendar) { tools += [CalendarReadTool(tools: self), CalendarChangeTool(tools: self)] }
        if offers(.reminders) { tools += [RemindersReadTool(tools: self), ReminderChangeTool(tools: self)] }
        if offers(.contacts) { tools.append(ContactsTool(tools: self)) }
        if hasFolders { tools.append(FilesTool(tools: self)) }
        if hasConnections { tools.append(ConnectionTool(tools: self)) }
        if canSend, let asker { tools.append(SendFileTool(tools: self, asker: asker)) }
        return tools
    }
}
