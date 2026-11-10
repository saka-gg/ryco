import Foundation
import zlib

/// Why a relay payload could not be inflated. The messages match the
/// JavaScript inflater's (`relayPayloadInflater.ts`).
enum RelayInflateError: Error, Equatable {
  case exceedsCap
  case endedBeforeStream
  case trailingBytes
  case corrupt

  var message: String {
    switch self {
    case .exceedsCap: return "Inflated relay payload exceeds its cap."
    case .endedBeforeStream: return "Compressed relay payload ended before its DEFLATE stream."
    case .trailingBytes: return "Compressed relay payload has bytes after its DEFLATE stream."
    case .corrupt: return "Compressed relay payload is not a valid DEFLATE stream."
    }
  }
}

/// Raw DEFLATE (RFC 1951, no zlib or gzip header) inflation with the relay's
/// rules (docs/relay-e2ee-protocol.md §4.6): at most `maxOutputBytes` of
/// output, and the stream must end exactly where the body does. A second
/// concatenated stream or trailing bytes are rejected, as
/// `DecompressionStream` rejects them on the web. Pure, so the test harness
/// compiles it on its own.
enum RelayInflate {
  static func inflateRaw(_ body: Data, maxOutputBytes: Int) throws -> Data {
    guard maxOutputBytes >= 0 else { throw RelayInflateError.exceedsCap }
    // One byte beyond the cap tells "exactly the cap" from "more than the cap".
    var output = Data(count: maxOutputBytes + 1)
    var stream = z_stream()
    // -15: raw DEFLATE with the largest window.
    guard
      inflateInit2_(&stream, -15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
    else { throw RelayInflateError.corrupt }
    defer { inflateEnd(&stream) }

    var status: Int32 = Z_OK
    var produced = 0
    var trailing = 0
    body.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
      output.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
        stream.next_in = UnsafeMutablePointer(
          mutating: input.bindMemory(to: Bytef.self).baseAddress)
        stream.avail_in = uInt(input.count)
        stream.next_out = out.bindMemory(to: Bytef.self).baseAddress
        stream.avail_out = uInt(out.count)
        repeat {
          status = inflate(&stream, Z_NO_FLUSH)
        } while status == Z_OK && stream.avail_in > 0 && stream.avail_out > 0
        produced = out.count - Int(stream.avail_out)
        trailing = Int(stream.avail_in)
      }
    }
    do {
      if produced > maxOutputBytes { throw RelayInflateError.exceedsCap }
      switch status {
      case Z_STREAM_END:
        if trailing != 0 { throw RelayInflateError.trailingBytes }
      case Z_OK, Z_BUF_ERROR:
        // All input consumed without the final block.
        throw RelayInflateError.endedBeforeStream
      default:
        throw RelayInflateError.corrupt
      }
    } catch {
      output.resetBytes(in: 0..<output.count)
      throw error
    }
    output.count = produced
    return output
  }
}
