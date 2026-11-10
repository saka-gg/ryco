Pod::Spec.new do |s|
  s.name           = 'RycoAppRuntime'
  s.version        = '1.0.0'
  s.summary        = 'Background stay and relay payload inflation for Ryco.'
  s.description    = 'A short iOS background task that keeps Hub connections through an app switch, and raw DEFLATE inflation of relay payloads off the JavaScript thread.'
  s.author         = 'Ryco'
  s.homepage       = 'https://ryco.dev'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.libraries = 'z'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.swift"
end
