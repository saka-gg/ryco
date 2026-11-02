/**
 * Self-signed public certificates made for the update-signing tests (their private keys were
 * discarded). Kept as strings: the app's .gitignore leaves every *.pem file out of the repo.
 */

/** As `npx expo-updates codesigning:generate` makes one: RSA, code-signing extended key usage. */
export const UPDATE_SIGNING_CERTIFICATE = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDHzCCAgegAwIBAgIUJA22trIJyJD5v/JAB0GmhuIo6+IwDQYJKoZIhvcNAQEL",
  "BQAwHDEaMBgGA1UEAwwRcnljby10ZXN0LXVwZGF0ZXMwIBcNMjYxMDMxMDQyMTQ1",
  "WhgPMjEyNjEwMDcwNDIxNDVaMBwxGjAYBgNVBAMMEXJ5Y28tdGVzdC11cGRhdGVz",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA19Uw/dOmuR4Lp2F5n9Rz",
  "FLgN5BxnNwrygi6Ew9OHMHH/GIap0H2mtgjBsnEn3fx/vkgvKBCY1DU9LGOh+zRC",
  "3Bp+lrkSfScPf14F0hJi08k8/jCYUHq08zgAJ18Xkd2D2nAsY/F/rTLHLPnxLDjC",
  "dbjVNWdt5GjMDblc/h0ygMUIgOAqTo+i+RATy+YVvrD8ZOtJdpD5B/lF5ZiNFnr7",
  "G511aewfPRcZBOiM1XOlv/gwAckrGwnPT0ODWSWD0HJmm/YPrEXgj/eJ5y3kvczY",
  "0reWccEo1zC8vU+/pX1GDj60vpqPEUaRUXC0XhTJ21VDMOIlexZsL8+MojRa9UUa",
  "nwIDAQABo1cwVTAdBgNVHQ4EFgQUOOE87woROXC5p3f4sEHvZ3J7BN0wDwYDVR0T",
  "AQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwMw",
  "DQYJKoZIhvcNAQELBQADggEBADw+YYcT3+AsByYBSa4EWTmoKJsV5ti4o0Jyrfkq",
  "qGfNIhUQly0eNXOapm0fMSNwitnUnjBvd4RLn4Pk6n461zPbnSrMD7c6uAGBS24/",
  "ttlOU855CWbxmvT3Vi1GyEFyM5JKxWRCxj285RgzvOR0/MBWOo8ksw3KzDkAUYg9",
  "cZD9PexVVeBlc2clClia5pKhglAt1hjoUaqdI8xDQiE7C+DOj0lz1hB7ks/+M92c",
  "ep2xA1uK3IVXNAzPkSNRXj7UOsxVUBD2YMhr+8Mc6gGZCpkuW0nJ/Vi94pbCtRon",
  "QuusqFhpdlVIY99TAlMiDHL0ctpj23/QzixzZlVtsnH8HLA=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");

/** RSA, but without the code-signing usage expo-updates requires. */
export const CERTIFICATE_WITHOUT_CODE_SIGNING = [
  "-----BEGIN CERTIFICATE-----",
  "MIIC+DCCAeCgAwIBAgIULEHPMo47kHDCUtROBPjAnGzCUjYwDQYJKoZIhvcNAQEL",
  "BQAwGzEZMBcGA1UEAwwQcnljby10ZXN0LW5vLWVrdTAgFw0yNjEwMzEwNDIxNDVa",
  "GA8yMTI2MTAwNzA0MjE0NVowGzEZMBcGA1UEAwwQcnljby10ZXN0LW5vLWVrdTCC",
  "ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMCK/SttmPtEnYdUVQJ8ldow",
  "weYf+EfTSY5LzUiFGa37oru0WP4PhiGZo0yC1abTzWcja305brb76HRugUd4TTOi",
  "OP9ojCUntsGku2AxYo7m6eeQz8eBXhch/rooBl2qjLgEbzyR8nQWaW8+O4D1fD1m",
  "ruhU6+KUMmGP4l+FLqYsZXOZc5PgBK8k2frhOVid9IQ8q0tnsxSHyjpG4tzcuDSl",
  "cUAKTC/DyeP+iPqhc42K3TRKVNw81uHzjPdLn/v2ijcMtwZdA8yG9thuwzZtG3XR",
  "tJRSJXGTZ3DRn+aSGPosxNYkW+0fvNoYnIYEtYTSRW2+kkzaNjjkk/hZRhrhaVsC",
  "AwEAAaMyMDAwHQYDVR0OBBYEFBC1g8HpkORrAk+FqIQtFF/d4hxQMA8GA1UdEwEB",
  "/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAH0A6l9wfahm/CqYzeCYJr4JZbQr",
  "mhgc8hL436NRgzCCo6/Au85o6WDuSbrnZuy8+DPzfHjfgivuLW42RcsZIpFBet+z",
  "341KR3U0mBrwgONqdbeflR0OFHuOj5Qf4EvWabYJOKM4HEiW+K9ccd3YRnArsP/e",
  "Q1NQ1gQuo6nxKK7l7J4grAsAGB/sfhnHvvDE7T6pvpMl3foK3bWhD82t2kx7e9lT",
  "ElC6Of14AnzcT3ej9t+SXIuZf0RVAJwNtwRiguN/NAEgQa1qR5ttaSTr/IQfQE54",
  "4ziIlUZ4wRFznfpF6rUZD7IL60Rv7JbyMB7N0px6/l/UZLb7MlCbY6KG7+c=",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
