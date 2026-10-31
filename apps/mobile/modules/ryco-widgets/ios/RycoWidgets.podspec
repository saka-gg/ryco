Pod::Spec.new do |s|
  s.name           = 'RycoWidgets'
  s.version        = '1.0.0'
  s.summary        = 'Widget timelines and the agent Live Activity for Ryco.'
  s.description    = 'Writes the widget timelines the app computes into the App Group it shares with its WidgetKit extension, and asks WidgetKit to reload them; starts, updates and ends the local agent Live Activity.'
  s.author         = 'Ryco'
  s.homepage       = 'https://ryco.dev'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = {
    :ios => '16.4',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit', 'ActivityKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.swift"
end
