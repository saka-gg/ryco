Pod::Spec.new do |s|
  s.name           = 'RycoPush'
  s.version        = '1.0.0'
  s.summary        = 'Push key for Ryco background alerts.'
  s.description    = 'Creates the per-installation X25519 push key in the keychain group the app shares with its notification service extension. Only the public key reaches JavaScript.'
  s.author         = 'Ryco'
  s.homepage       = 'https://ryco.dev'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'CryptoKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.swift"
end
