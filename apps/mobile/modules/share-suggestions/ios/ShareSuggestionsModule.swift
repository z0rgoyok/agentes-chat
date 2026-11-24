import ExpoModulesCore
import Intents

/// The agents in the system's share sheet (ADR 0213). Each message a person sends to an agent is donated as a sent
/// message (`INSendMessageIntent`), named by the agent and drawn with its face, and iOS offers the conversations used
/// most at the top of the share sheet, beside the person's contacts. The share extension reads the one picked
/// (`extensionContext.intent`) and puts it on its link to the app (plugins/with-share-suggestions.js).
public class ShareSuggestionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShareSuggestions")

    // A message sent in conversation `id` (a workspace's agent), named `name`; `face`: a PNG in base64, or none.
    AsyncFunction("donate") { (id: String, name: String, face: String?, promise: Promise) in
      let intent = INSendMessageIntent(
        recipients: nil,
        outgoingMessageType: .outgoingMessageText,
        content: nil,
        speakableGroupName: INSpeakableString(spokenPhrase: name),
        conversationIdentifier: id,
        serviceName: nil,
        sender: nil,
        attachments: nil
      )
      if let face, let data = Data(base64Encoded: face) {
        intent.setImage(INImage(imageData: data), forParameterNamed: \.speakableGroupName)
      }
      let interaction = INInteraction(intent: intent, response: nil)
      interaction.direction = .outgoing
      // Grouped by conversation, so one conversation's suggestions can be taken back (`forget`).
      interaction.groupIdentifier = id
      interaction.donate { error in
        promise.resolve(error == nil)
      }
    }

    // One conversation's suggestions gone (its agent removed).
    AsyncFunction("forget") { (id: String, promise: Promise) in
      INInteraction.delete(with: id) { _ in
        promise.resolve(nil)
      }
    }

    // Every suggestion gone: signed out, the next account starts with none.
    AsyncFunction("forgetAll") { (promise: Promise) in
      INInteraction.deleteAll { _ in
        promise.resolve(nil)
      }
    }
  }
}
