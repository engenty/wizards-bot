import Foundation
import FoundationModels
import OSLog

/// The model on this device (Apple Foundation Models). It answers while the home is out of reach,
/// and when no home is paired, and it works on the questions the home's agents hand to this phone.
/// With the phone's tools it reads what the phone keeps; what it read stays here.
final class OnDeviceAgent {
    /// What `Message.model` reads for a message this device wrote.
    static let modelRef = "apple:on-device"

    enum Problem: Error {
        /// No model here; the sentence says why.
        case unavailable(String)
        /// The model would not or could not answer; the sentence says so.
        case failed(String)
    }

    /// Nil when the model can answer; else a sentence that says why it can't.
    var unavailable: String? {
        #if targetEnvironment(simulator)
        // The Simulator reports the model as there, but it lacks the model's safety assets and
        // every answer fails.
        return String(localized: "The Simulator has no model of its own. Pair it with your home.")
        #else
        switch SystemLanguageModel.default.availability {
        case .available:
            nil
        case .unavailable(.deviceNotEligible):
            String(localized: "This device can’t run a model of its own.")
        case .unavailable(.appleIntelligenceNotEnabled):
            String(localized: "Apple Intelligence is switched off on this device. You can switch it on in Settings.")
        case .unavailable(.modelNotReady):
            String(localized: "The model on this device is still loading. Try again in a few minutes.")
        case .unavailable:
            String(localized: "The model on this device isn’t available right now.")
        }
        #endif
    }

    var isAvailable: Bool { unavailable == nil }

    private var sessions: [String: LanguageModelSession] = [:]
    private let log = Logger(subsystem: "bot.wizards", category: "on-device")
    /// The phone's tools for a conversation on this phone: nothing in them leaves the phone.
    var makeTools: (() -> PhoneTools)?

    /// Loads the model while the person is still typing or talking.
    func prewarm(conversationId: String, agentName: String, personName: String?, earlier: [Message]) {
        guard isAvailable else { return }
        session(for: conversationId, agentName: agentName, personName: personName, earlier: earlier).prewarm()
    }

    /// Answers `text`; `onText` gets the whole answer so far each time it grows.
    func answer(
        _ text: String, in conversationId: String, agentName: String, personName: String?, spoken: Bool,
        earlier: [Message], onText: (String) -> Void
    ) async throws {
        if let unavailable { throw Problem.unavailable(unavailable) }
        let prompt = spoken
            ? "\(text)\n\n(The person spoke this and listens to the answer: reply in two or three short plain sentences, without Markdown.)"
            : text
        for attempt in 0 ..< 2 {
            let session = session(for: conversationId, agentName: agentName, personName: personName, earlier: earlier)
            do {
                var last = ""
                for try await snapshot in session.streamResponse(to: prompt, options: GenerationOptions(temperature: 0.4)) {
                    last = snapshot.content
                    onText(last)
                }
                if last.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    throw Problem.failed(String(localized: "The model on this device gave no answer."))
                }
                return
            } catch LanguageModelSession.GenerationError.exceededContextWindowSize where attempt == 0 {
                // A long conversation: start over with only its last lines.
                sessions[conversationId] = nil
            } catch LanguageModelSession.GenerationError.guardrailViolation {
                throw Problem.failed(String(localized: "The model on this device doesn’t answer this. Your home can, once it is back."))
            } catch LanguageModelSession.GenerationError.unsupportedLanguageOrLocale {
                throw Problem.failed(String(localized: "The model on this device doesn’t speak this language."))
            } catch let problem as Problem {
                throw problem
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                log.error("The model failed: \(String(describing: error), privacy: .public)")
                sessions[conversationId] = nil
                throw Problem.failed(String(localized: "The model on this device couldn’t answer."))
            }
        }
    }

    /// Works on a question one of the home's agents handed to this phone, with the phone's tools,
    /// and returns only the answer for that agent.
    func work(on handoff: Handoff, personName: String?, tools: PhoneTools) async throws -> String {
        if let unavailable { throw Problem.unavailable(unavailable) }
        let person = personName.flatMap { $0.isEmpty ? nil : $0 } ?? "the person"
        let instructions = """
        You are the agent on \(person)'s phone. \(handoff.agentName), another agent of \(person), needs something \
        that only this phone has. \(Self.today()) Find it with your tools in what this phone keeps. Then answer \
        \(handoff.agentName) in a few short sentences with only what it asked for: the findings, not everything you read. \
        Change something only when it asked for a change; \(person) is asked on the phone first. \
        When the phone has no answer, say so. Answer in the language of the question.
        """
        let session = LanguageModelSession(tools: tools.modelTools(asker: handoff.agentName), instructions: instructions)
        do {
            let answer = try await session.respond(to: handoff.text, options: GenerationOptions(temperature: 0.2)).content
            let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw Problem.failed(String(localized: "The model on this device gave no answer.")) }
            return text
        } catch LanguageModelSession.GenerationError.exceededContextWindowSize {
            throw Problem.failed(String(localized: "The question needed more than the model on this device can read at once."))
        } catch LanguageModelSession.GenerationError.guardrailViolation {
            throw Problem.failed(String(localized: "The model on this device doesn’t answer this."))
        } catch LanguageModelSession.GenerationError.unsupportedLanguageOrLocale {
            throw Problem.failed(String(localized: "The model on this device doesn’t speak this language."))
        } catch let problem as Problem {
            throw problem
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            log.error("The model failed on a hand-off: \(String(describing: error), privacy: .public)")
            throw Problem.failed(String(localized: "The model on this device couldn’t answer."))
        }
    }

    /// The day and time, for instructions: the tools take dates, and the model has no clock.
    static func today(_ now: Date = .now) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = "EEEE d MMMM yyyy, HH:mm"
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_GB")
        day.dateFormat = "yyyy-MM-dd"
        return "It is \(formatter.string(from: now)) (\(day.string(from: now)))."
    }

    /// Forgets a conversation, so the next answer starts from what the chat shows.
    func forget(_ conversationId: String) {
        sessions[conversationId] = nil
    }

    private func session(for conversationId: String, agentName: String, personName: String?, earlier: [Message]) -> LanguageModelSession {
        if let session = sessions[conversationId], !session.isResponding { return session }
        let tools = makeTools?()
        let reaches = tools.map { $0.modelTools(asker: nil) } ?? []
        var instructions = """
        You are \(agentName), a personal agent. You are answering on the person's phone, with the phone's own model, \
        because their home is out of reach right now. \(Self.today())
        """ + " "
        instructions += reaches.isEmpty
            ? "From here you can't read mail, calendars, files or the web, and you can't do anything for them. "
            : "With your tools you read what this phone keeps (\(reaches.map(\.name).joined(separator: ", "))), and you add or change calendar entries and reminders: the person is asked on the phone first. Use a tool only when the question needs it. You can't read mail or the web. "
        instructions += """
        When they ask for something you can't reach, say plainly that it has to wait until the home is back, and help \
        with what you can: thinking, writing, explaining, planning. \
        Answer briefly and calmly, in the language the person writes in. Never invent facts about their life.
        """
        if let personName, !personName.isEmpty { instructions += "\nThe person's name is \(personName)." }
        // The tools take room of the model's 4 000 tokens: the conversation gets less of it then.
        let lines = earlier.suffix(reaches.isEmpty ? 8 : 4).compactMap { message -> String? in
            let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, message.role == .you || message.role == .agent else { return nil }
            return "\(message.role == .you ? "Person" : agentName): \(text.prefix(reaches.isEmpty ? 400 : 240))"
        }
        if !lines.isEmpty { instructions += "\n\nThe conversation so far:\n" + lines.joined(separator: "\n") }
        let session = LanguageModelSession(tools: reaches, instructions: instructions)
        sessions[conversationId] = session
        return session
    }
}
