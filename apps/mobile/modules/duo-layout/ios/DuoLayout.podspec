# The iPhone Duo's fold and size class for the app's two panes (ADR 0212): a local Expo module, linked by
# `expo prebuild` from apps/mobile/modules. iOS only: Android has no module, and the app reads the window's width there.
Pod::Spec.new do |s|
  s.name           = 'DuoLayout'
  s.version        = '1.0.0'
  s.summary        = "Where the iPhone Duo's fold crosses a view, and whether the window is regular width."
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'agentes.chat'
  s.homepage       = 'https://agentes.chat'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/agentes-chat/agentes-chat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
