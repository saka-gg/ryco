import CryptoKit
import Foundation

/// Opens a `ryco-push-seal-v1` blob (`docs/push-alerts.md`) exactly as
/// `packages/shared/src/pushSeal.ts` seals it:
///
/// 1. `blob = 0x01 ‖ E ‖ ciphertext ‖ tag`, with `E` the sender's ephemeral
///    X25519 key;
/// 2. `dh = X25519(device key, E)`, refused when all zero;
/// 3. `HKDF-SHA256(dh, salt: E ‖ R, info: "ryco push seal v1")`, 44 bytes: the
///    ChaCha20-Poly1305 key, then its nonce (`R` is the device's public key);
/// 4. the associated data binds the blob to the routing the Hub sees.
///
/// `pushSealOpener.test.ts` compiles this file with `swiftc` and opens every
/// vector in `pushSeal.vectors.json`. Foundation and CryptoKit only.
enum PushSealOpener {
  static let version: UInt8 = 0x01
  private static let keyBytes = 32
  private static let nonceBytes = 12
  private static let tagBytes = 16
  private static let info = Data("ryco push seal v1".utf8)

  static func associatedData(environmentId: String, sequence: Int64, enrollmentId: String) -> Data {
    Data("ryco-push-v1\n\(environmentId)\n\(sequence)\n\(enrollmentId)".utf8)
  }

  /// The plaintext, or nil when the blob is not a v1 seal to this key with this binding.
  static func open(
    sealed: Data,
    privateKey: Curve25519.KeyAgreement.PrivateKey,
    associatedData: Data
  ) -> Data? {
    let bytes = [UInt8](sealed)
    guard bytes.count >= 1 + keyBytes + tagBytes, bytes[0] == version else { return nil }
    let ephemeralKey = Data(bytes[1..<(1 + keyBytes)])
    guard
      let ephemeral = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephemeralKey),
      let sharedSecret = try? privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
    else { return nil }
    // A low-order ephemeral key yields an all-zero secret; the sealer refuses it too.
    let allZero = sharedSecret.withUnsafeBytes { raw in raw.allSatisfy { $0 == 0 } }
    guard !allZero else { return nil }

    let derived = sharedSecret.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: ephemeralKey + privateKey.publicKey.rawRepresentation,
      sharedInfo: info,
      outputByteCount: keyBytes + nonceBytes
    )
    let material = derived.withUnsafeBytes { Data($0) }
    let body = Data(bytes[(1 + keyBytes)...])
    guard
      let nonce = try? ChaChaPoly.Nonce(data: Data(material.suffix(nonceBytes))),
      let box = try? ChaChaPoly.SealedBox(
        nonce: nonce,
        ciphertext: Data(body.prefix(body.count - tagBytes)),
        tag: Data(body.suffix(tagBytes))
      )
    else { return nil }
    return try? ChaChaPoly.open(
      box,
      using: SymmetricKey(data: Data(material.prefix(keyBytes))),
      authenticating: associatedData
    )
  }
}
