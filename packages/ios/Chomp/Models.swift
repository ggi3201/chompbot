import Foundation

struct ChatMessage: Identifiable, Equatable {
    var id: String
    let role: Role
    var content: String
    let createdAt: Date
    var agentUsed: String?
    var turnId: String? = nil
    var isStreaming: Bool = false
    /// The server's timestamp text, the cursor for loading the page before this message.
    var cursor: String? = nil

    enum Role: String { case user, assistant, system }
}

struct Conversation: Identifiable, Equatable {
    let id: String
    var title: String
    var messages: [ChatMessage]
    var updatedAt: Date
    /// An agent is working in it now.
    var running = false
    /// Its agent waits on an answer or an approval.
    var needsInput = false
    /// A reply came after you last had it on screen, on any device.
    var unread = false
}

/// A question an agent asked with `ask_user`. The next thing the user sends answers it.
struct PendingQuestion: Equatable {
    let sessionId: String
    let question: String
    let conversationId: String?
}

/// Streaming events emitted by the chat WebSocket. Loosely typed to mirror
/// the existing server messages without coupling tightly to internal shapes.
enum ChatEvent {
    case conversationStarted(id: String)
    case agentMessage(id: String, content: String, agentUsed: String?, turnId: String?, conversationId: String?)
    case items([ChatItem])
    case chunk(String, conversationId: String?)
    /// The turn ended. `reply` is its final text, when no earlier event delivered it.
    case done(reply: ChatMessage?, messageId: String?, conversationId: String?)
    case cancelled
    case agentProgress(status: String, elapsedSeconds: Int, conversationId: String?)
    case agentActivity(text: String, conversationId: String?)
    case question(sessionId: String, question: String, conversationId: String?)
    case syncComplete(conversationId: String?, lastMessage: ChatMessage?)
    /// A `/handoff` turn wrote its note. The app opens a new chat with it in the composer.
    case handoff(conversationId: String, content: String)
    case heartbeat
    case error(String)
    case unknown(type: String)
}
