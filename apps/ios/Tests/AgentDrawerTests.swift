import Foundation
import Testing

/// The list of agents on a phone: what a row says, and how the drawer follows the finger.
@Suite struct AgentDrawerTests {
    private func agent(_ more: String = "") throws -> Agent {
        try JSONDecoder().decode(Agent.self, from: Data("""
        { "id": "agt_1", "name": "Travel", "kind": "drop", "about": "Books trains, flights and rooms.", "origin": "own",
          "state": "idle", "open": 0, "conversationId": "cnv_1", "main": false\(more) }
        """.utf8))
    }

    @Test func theLineOfARow() throws {
        // Nothing said yet: what the agent does.
        var agent = try agent()
        #expect(AgentList.line(for: agent) == .about("Books trains, flights and rooms."))

        // The newest message, without its marks.
        agent.preview = "**Booked**: the [train](https://example.com) at 9:12."
        #expect(AgentList.line(for: agent) == .message("Booked: the train at 9:12."))

        // While the agent writes, that is what the line says, over the last message.
        agent.state = .working
        #expect(AgentList.line(for: agent) == .writing)

        // A message that is only marks counts as none.
        agent.state = .idle
        agent.preview = "  "
        #expect(AgentList.line(for: agent) == .about("Books trains, flights and rooms."))
    }

    @Test func theLineOfASharedAgent() throws {
        var agent = try agent(#", "from": "anna@anna.example""#)
        // An own agent never says whose it is.
        #expect(AgentList.line(for: agent) == .about("Books trains, flights and rooms."))
        agent.origin = .shared
        #expect(AgentList.line(for: agent) == .from("anna@anna.example"))
        agent.preview = "Watered."
        #expect(AgentList.line(for: agent) == .message("Watered."))
        // Shared, but nobody named: what it does.
        agent.preview = ""
        agent.from = ""
        #expect(AgentList.line(for: agent) == .about("Books trains, flights and rooms."))
    }

    @Test func theWidthOfTheDrawer() {
        // About 85% of a phone, at most 340 points.
        #expect(DrawerMotion.width(window: 393) == 334)
        #expect(DrawerMotion.width(window: 375) == 319)
        #expect(DrawerMotion.width(window: 440) == 340)
        #expect(DrawerMotion.width(window: 1024) == 340)
        #expect(DrawerMotion.width(window: 0) == 0)
    }

    @Test func itFollowsTheFinger() {
        let width: CGFloat = 300
        // At rest.
        #expect(DrawerMotion.progress(open: false, translation: nil, width: width) == 0)
        #expect(DrawerMotion.progress(open: true, translation: nil, width: width) == 1)
        // Pulled from the edge, pushed back on the open list.
        #expect(DrawerMotion.progress(open: false, translation: 150, width: width) == 0.5)
        #expect(DrawerMotion.progress(open: true, translation: -75, width: width) == 0.75)
        // Never past open or closed.
        #expect(DrawerMotion.progress(open: false, translation: 900, width: width) == 1)
        #expect(DrawerMotion.progress(open: true, translation: -900, width: width) == 0)
        #expect(DrawerMotion.progress(open: false, translation: -40, width: width) == 0)
        // Before the window is measured.
        #expect(DrawerMotion.progress(open: true, translation: -50, width: 0) == 1)
    }

    @Test func whereItSettles() {
        let width: CGFloat = 300
        // Where it would come to rest decides: more than half open stays open.
        #expect(DrawerMotion.staysOpen(open: false, predicted: 200, width: width))
        #expect(!DrawerMotion.staysOpen(open: false, predicted: 100, width: width))
        #expect(DrawerMotion.staysOpen(open: true, predicted: -100, width: width))
        #expect(!DrawerMotion.staysOpen(open: true, predicted: -200, width: width))
        // A flick to the left closes it, though the finger moved only a little.
        #expect(!DrawerMotion.staysOpen(open: true, predicted: -40 - 1_200 * 0.2, width: width))
        // A cancelled swipe from the edge leaves it closed.
        #expect(!DrawerMotion.staysOpen(open: false, predicted: 0, width: width))
    }
}
