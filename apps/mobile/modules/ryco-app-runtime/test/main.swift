// The harness `relayInflate.test.ts` compiles with `RelayInflate.swift`. It
// reads cases as JSON from the file named by its argument, inflates each the
// way the app module does, and prints the results as JSON.
import Foundation

func hexBytes(_ hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

struct Case: Decodable {
  let body: String
  let maxOutputBytes: Int
}

let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: input)
var results: [[String: Any]] = []
for item in cases {
  do {
    let output = try RelayInflate.inflateRaw(hexBytes(item.body), maxOutputBytes: item.maxOutputBytes)
    results.append(["output": hex(output)])
  } catch let error as RelayInflateError {
    results.append(["error": error.message])
  }
}
let json = try JSONSerialization.data(withJSONObject: results, options: [])
FileHandle.standardOutput.write(json)
