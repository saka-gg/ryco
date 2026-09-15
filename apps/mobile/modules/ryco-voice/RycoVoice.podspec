Pod::Spec.new do |s|
  s.name = 'RycoVoice'
  s.version = '0.0.0'
  s.summary = 'Bounded in-memory microphone capture for Ryco.'
  s.homepage = 'https://ryco.dev'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'Ryco' => 'hello@ryco.dev' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift'
  s.frameworks = 'AVFoundation'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
