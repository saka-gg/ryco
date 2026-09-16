import SwiftUI

@main
struct SimulatorComputerUseFixture: App {
    @State private var count = 0
    @State private var sample = ""

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 24) {
                Text("Ryco computer-use test").font(.title2)
                Text("Count \(count)").font(.largeTitle).accessibilityIdentifier("counter")
                Button("Increment") { count += 1 }
                    .buttonStyle(.borderedProminent)
                TextField("Sample text", text: $sample)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Sample text")
                Text("Entered: \(sample)").accessibilityIdentifier("entered")
                ScrollView {
                    VStack(spacing: 30) {
                        ForEach(1...30, id: \.self) { index in
                            Text("Test row \(index)").frame(maxWidth: .infinity)
                        }
                    }
                }
                .accessibilityLabel("Test rows")
            }
            .padding(24)
            .background(Color.white)
            .preferredColorScheme(.light)
        }
    }
}
