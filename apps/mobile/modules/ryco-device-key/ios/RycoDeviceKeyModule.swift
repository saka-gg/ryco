import ExpoModulesCore
import Foundation
import Security

/// Secure Enclave P-256 key used to sign DPoP proofs for the hosted plane.
///
/// The private key is generated inside the Secure Enclave, marked
/// non-exportable, and never crosses into JS — this module exposes no export or
/// extract path by design. If the enclave is unavailable (notably on the
/// Simulator) key creation fails closed: there is no software fallback, because
/// a software key would collapse DPoP down to bare bearer assurance.
public final class RycoDeviceKeyModule: Module {
  /// Stable per-install tag. Changing it orphans the existing key and forces a
  /// fresh hosted login, so it must stay constant across releases.
  private static let applicationTag = "dev.ryco.hostedhub.dpop.p256".data(using: .utf8)!

  public func definition() -> ModuleDefinition {
    Name("RycoDeviceKey")

    AsyncFunction("ensureKey") { () -> [String: Any] in
      // Never report a backing we have not verified. A key already present
      // under this tag — left by an earlier build, or by another component
      // sharing the access group — may be an ordinary software key, and
      // accepting it would silently reduce DPoP to bare bearer assurance.
      var key = try Self.loadKey()
      if let existing = key {
        switch Self.residency(of: existing) {
        case .secureEnclave:
          break
        case .software:
          // Positively not enclave-resident: replace it.
          Self.deleteKey()
          key = nil
        case .unknown:
          // Refuse, but never destroy. A probe that cannot read the attribute
          // must not delete a key that may be a perfectly good enclave key —
          // that would orphan one on every launch and permanently disable
          // hosted mode.
          throw DeviceKeyError.residencyUnverifiable
        }
      }
      let resolved = try key ?? Self.createKey()
      guard Self.residency(of: resolved) == .secureEnclave else {
        throw DeviceKeyError.enclaveUnavailable(nil)
      }
      return [
        "publicKey": try Self.exportPublicKey(resolved).base64EncodedString(),
        "backing": "secure-enclave",
      ]
    }

    AsyncFunction("sign") { (payloadBase64: String) -> String in
      guard let payload = Data(base64Encoded: payloadBase64) else {
        throw DeviceKeyError.invalidPayload
      }
      guard let key = try Self.loadKey() else {
        throw DeviceKeyError.keyMissing
      }
      return try Self.sign(payload: payload, with: key).base64EncodedString()
    }

    AsyncFunction("deleteKey") { () -> Void in
      Self.deleteKey()
    }
  }

  // MARK: - Keychain

  private static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag as String: applicationTag,
    ]
  }

  enum KeyResidency {
    case secureEnclave
    /// Positively determined not to live in the enclave.
    case software
    /// The attribute could not be read; residency is undetermined.
    case unknown
  }

  /// Where the private key actually lives.
  ///
  /// The keychain query matches on the application tag alone, so this is the
  /// only thing distinguishing an enclave key from a software key stored under
  /// the same tag. `unknown` is kept distinct from `software` on purpose: the
  /// caller may replace a software key, but must never destroy one it merely
  /// failed to measure.
  private static func residency(of key: SecKey) -> KeyResidency {
    guard let attributes = SecKeyCopyAttributes(key) as? [String: Any] else { return .unknown }
    guard let tokenID = attributes[kSecAttrTokenID as String] else { return .software }
    guard let tokenString = tokenID as? String else { return .unknown }
    return tokenString == (kSecAttrTokenIDSecureEnclave as String) ? .secureEnclave : .software
  }

  private static func loadKey() throws -> SecKey? {
    var query = baseQuery()
    query[kSecReturnRef as String] = true

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let result = item, CFGetTypeID(result) == SecKeyGetTypeID()
    else {
      throw DeviceKeyError.keychain(status)
    }
    return (result as! SecKey)
  }

  private static func createKey() throws -> SecKey {
    var accessError: Unmanaged<CFError>?
    // `.privateKeyUsage` alone: a DPoP proof is minted on every authenticated
    // request, so gating the key on biometry or user presence would prompt the
    // user continuously. Device-only accessibility keeps the key off backups
    // and off other devices.
    guard
      let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .privateKeyUsage,
        &accessError
      )
    else {
      throw DeviceKeyError.accessControl(accessError?.takeRetainedValue())
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: applicationTag,
        kSecAttrAccessControl as String: access,
      ],
    ]

    var createError: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
      // The Simulator has no Secure Enclave, so this is the expected failure
      // path there. Fail closed rather than falling back to a software key.
      throw DeviceKeyError.enclaveUnavailable(createError?.takeRetainedValue())
    }
    return key
  }

  private static func deleteKey() {
    SecItemDelete(baseQuery() as CFDictionary)
  }

  // MARK: - Key material

  /// X9.63 uncompressed point (`0x04 ‖ X(32) ‖ Y(32)`) for the public half only.
  private static func exportPublicKey(_ key: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(key) else {
      throw DeviceKeyError.publicKeyUnavailable
    }
    var error: Unmanaged<CFError>?
    guard let representation = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw DeviceKeyError.publicKeyExport(error?.takeRetainedValue())
    }
    return representation
  }

  /// Returns an ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`; the JS layer
  /// converts it to the raw `r ‖ s` form JWS ES256 requires.
  private static func sign(payload: Data, with key: SecKey) throws -> Data {
    let algorithm: SecKeyAlgorithm = .ecdsaSignatureMessageX962SHA256
    guard SecKeyIsAlgorithmSupported(key, .sign, algorithm) else {
      throw DeviceKeyError.algorithmUnsupported
    }
    var error: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(key, algorithm, payload as CFData, &error) as Data?
    else {
      throw DeviceKeyError.signing(error?.takeRetainedValue())
    }
    return signature
  }
}

/// Bounded errors. Messages are fixed strings so no key material, payload, or
/// unbounded platform detail reaches JS.
private enum DeviceKeyError: Error, LocalizedError {
  case enclaveUnavailable(CFError?)
  case accessControl(CFError?)
  case keychain(OSStatus)
  case keyMissing
  case publicKeyUnavailable
  case publicKeyExport(CFError?)
  case algorithmUnsupported
  case signing(CFError?)
  case invalidPayload
  case residencyUnverifiable

  var errorDescription: String? {
    switch self {
    case .enclaveUnavailable:
      return "Secure Enclave is unavailable on this device."
    case .accessControl:
      return "Secure Enclave access control could not be created."
    case .keychain:
      return "The device key could not be read from the keychain."
    case .keyMissing:
      return "No device key exists."
    case .publicKeyUnavailable, .publicKeyExport:
      return "The device public key could not be read."
    case .algorithmUnsupported:
      return "The device key does not support ES256 signing."
    case .signing:
      return "The device key could not sign the request."
    case .invalidPayload:
      return "The signing payload was malformed."
    case .residencyUnverifiable:
      return "The device key's hardware backing could not be verified."
    }
  }
}
