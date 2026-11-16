package expo.modules.rycodevicekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * StrongBox-preferred, hardware-backed P-256 key used for Hub DPoP and native E2EE identity.
 *
 * The private key is generated inside Android Keystore, is non-exportable, and never crosses into JS.
 * A proven TEE key is accepted only when StrongBox creation is unavailable. Software custody is never
 * accepted, and an uncertain residency check never deletes an existing key.
 */
class RycoDeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RycoDeviceKey")

    AsyncFunction("ensureKey") {
      val resolved = ensureHardwareKey()
      mapOf(
        "publicKey" to encodePublicKey(resolved.alias),
        "backing" to resolved.backing,
      )
    }

    AsyncFunction("sign") { payloadBase64: String ->
      val payload =
        try {
          Base64.decode(payloadBase64, Base64.NO_WRAP)
        } catch (cause: IllegalArgumentException) {
          throw MalformedPayloadException()
        }
      val privateKey = activeHardwareKey()?.privateKey ?: throw KeyMissingException()
      val signature =
        Signature.getInstance(SIGNATURE_ALGORITHM).run {
          initSign(privateKey)
          update(payload)
          sign()
        }
      Base64.encodeToString(signature, Base64.NO_WRAP)
    }

    AsyncFunction("deleteKey") {
      val store = keyStore()
      store.deleteEntry(STRONGBOX_KEY_ALIAS)
      store.deleteEntry(TEE_KEY_ALIAS)
    }
  }

  private data class HardwareKey(
    val alias: String,
    val privateKey: PrivateKey,
    val backing: String,
  )

  private fun keyStore(): KeyStore =
    KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun loadPrivateKey(alias: String): PrivateKey? =
    try {
      keyStore().getKey(alias, null) as? PrivateKey
    } catch (cause: Exception) {
      throw KeystoreUnavailableException()
    }

  /** Serialize create-only alias selection so concurrent ensure calls cannot replace each other. */
  @Synchronized
  private fun ensureHardwareKey(): HardwareKey {
    activeHardwareKey()?.let { return it }
    val strongBox = tryCreateStrongBoxKey()
    if (strongBox != null) return requireHardwareKey(STRONGBOX_KEY_ALIAS, strongBox)
    val tee = loadPrivateKey(TEE_KEY_ALIAS) ?: createKey(TEE_KEY_ALIAS, false)
    return requireHardwareKey(TEE_KEY_ALIAS, tee, requireTee = true)
  }

  /** Prefer an existing valid StrongBox alias, then the dedicated TEE fallback alias. */
  private fun activeHardwareKey(): HardwareKey? {
    val strongBox = loadPrivateKey(STRONGBOX_KEY_ALIAS)
    if (strongBox != null) return requireHardwareKey(STRONGBOX_KEY_ALIAS, strongBox)
    val tee = loadPrivateKey(TEE_KEY_ALIAS)
    if (tee != null) return requireHardwareKey(TEE_KEY_ALIAS, tee, requireTee = true)
    return null
  }

  private fun requireHardwareKey(
    alias: String,
    privateKey: PrivateKey,
    requireTee: Boolean = false,
  ): HardwareKey {
    val backing = backingOf(privateKey)
    if (backing == BACKING_UNKNOWN) throw ResidencyUnverifiableException()
    if (backing == BACKING_UNAVAILABLE || (requireTee && backing != BACKING_TEE)) {
      throw HardwareBackingUnsupportedException()
    }
    return HardwareKey(alias, privateKey, backing)
  }

  private fun tryCreateStrongBoxKey(): PrivateKey? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
    return try {
      createKey(STRONGBOX_KEY_ALIAS, true)
    } catch (cause: StrongBoxUnavailableException) {
      null
    }
  }

  private fun createKey(alias: String, strongBox: Boolean): PrivateKey {
    val builder =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(false)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }
    return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
      .apply { initialize(builder.build()) }
      .generateKeyPair()
      .private
  }

  /** Report only residency that KeyInfo itself proves. */
  private fun backingOf(privateKey: PrivateKey): String {
    val keyInfo =
      try {
        KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
          .getKeySpec(privateKey, KeyInfo::class.java)
      } catch (cause: Exception) {
        return BACKING_UNKNOWN
      }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (keyInfo.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> BACKING_STRONGBOX
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> BACKING_TEE
        else -> BACKING_UNAVAILABLE
      }
    }
    // Older Android proves only the TEE lower bound, never the stronger StrongBox label.
    @Suppress("DEPRECATION")
    return if (keyInfo.isInsideSecureHardware) BACKING_TEE else BACKING_UNAVAILABLE
  }

  /** X9.63 uncompressed point (`0x04 || X(32) || Y(32)`) for the public half only. */
  private fun encodePublicKey(alias: String): String {
    val certificate = keyStore().getCertificate(alias) ?: throw PublicKeyUnavailableException()
    val publicKey = certificate.publicKey as? ECPublicKey ?: throw PublicKeyUnavailableException()
    val point = publicKey.w
    val encoded = ByteArray(1 + COORDINATE_BYTES * 2)
    encoded[0] = UNCOMPRESSED_PREFIX
    writeCoordinate(point.affineX, encoded, 1)
    writeCoordinate(point.affineY, encoded, 1 + COORDINATE_BYTES)
    return Base64.encodeToString(encoded, Base64.NO_WRAP)
  }

  private fun writeCoordinate(value: BigInteger, destination: ByteArray, offset: Int) {
    val bytes = value.toByteArray()
    val start = if (bytes.size > COORDINATE_BYTES) bytes.size - COORDINATE_BYTES else 0
    val length = bytes.size - start
    if (length > COORDINATE_BYTES) throw PublicKeyUnavailableException()
    bytes.copyInto(destination, offset + COORDINATE_BYTES - length, start, bytes.size)
  }

  private companion object {
    /** Existing stable alias: never rename it or a valid deployed StrongBox key is orphaned. */
    const val STRONGBOX_KEY_ALIAS = "dev.ryco.hostedhub.dpop.p256"
    const val TEE_KEY_ALIAS = "dev.ryco.hostedhub.dpop.p256.tee"
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val CURVE = "secp256r1"
    const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    const val COORDINATE_BYTES = 32
    const val UNCOMPRESSED_PREFIX: Byte = 0x04
    const val BACKING_STRONGBOX = "strongbox"
    const val BACKING_TEE = "tee"
    const val BACKING_UNAVAILABLE = "unavailable"
    const val BACKING_UNKNOWN = "unknown"
  }
}

/** Fixed messages keep platform details and key-shaped material out of JS/logging surfaces. */
private class HardwareBackingUnsupportedException :
  CodedException("Hardware-backed key storage is unavailable on this device.")

private class ResidencyUnverifiableException :
  CodedException("The device key's hardware backing could not be verified.")

private class KeystoreUnavailableException :
  CodedException("The device key could not be read from the keystore.")

private class KeyMissingException : CodedException("No device key exists.")

private class PublicKeyUnavailableException :
  CodedException("The device public key could not be read.")

private class MalformedPayloadException : CodedException("The signing payload was malformed.")
