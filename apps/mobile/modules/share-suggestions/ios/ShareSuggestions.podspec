# The agents in the system's share sheet (ADR 0213): a local Expo module, linked by `expo prebuild` from apps/mobile/modules.
Pod::Spec.new do |s|
  s.name           = 'ShareSuggestions'
  s.version        = '1.0.0'
  s.summary        = 'The agents a person sends to, offered at the top of the system share sheet.'
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'agentes.chat'
  s.homepage       = 'https://agentes.chat'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/agentes-chat/agentes-chat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Intents'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
