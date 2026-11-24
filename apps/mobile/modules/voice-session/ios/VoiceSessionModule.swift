import AVFoundation
import AudioToolbox
import ExpoModulesCore

/// What a voice take needs from the audio session (ADR 0100 §"Starting a take"). While the session records, iOS
/// mutes haptics and system sounds unless the app allows them (`allowHapticsAndSystemSoundsDuringRecording`, false
/// by default), and the audio library never does: the take's haptics never reached the hand. The take's start sound
/// plays as a system sound, which keeps to the ringer switch and volume while the session plays in silent mode.
public class VoiceSessionModule: Module {
  /// One system sound per file, made on first use.
  private var sounds: [String: SystemSoundID] = [:]

  public func definition() -> ModuleDefinition {
    Name("VoiceSession")

    Function("allowFeedbackWhileRecording") { () -> Void in
      try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
    }

    Function("playSystemSound") { (uri: String) -> Bool in
      if let id = self.sounds[uri] {
        AudioServicesPlaySystemSound(id)
        return true
      }
      guard let url = URL(string: uri) else { return false }
      var id: SystemSoundID = 0
      guard AudioServicesCreateSystemSoundID(url as CFURL, &id) == kAudioServicesNoError else { return false }
      self.sounds[uri] = id
      AudioServicesPlaySystemSound(id)
      return true
    }

    OnDestroy {
      for id in self.sounds.values {
        AudioServicesDisposeSystemSoundID(id)
      }
      self.sounds.removeAll()
    }
  }
}
