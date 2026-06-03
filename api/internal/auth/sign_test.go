package auth_test

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
)

// signRS256 signs the message bytes with the given RSA private key using PKCS1v15 + SHA256.
func signRS256(key *rsa.PrivateKey, msg []byte) ([]byte, error) {
	h := sha256.New()
	h.Write(msg)
	digest := h.Sum(nil)
	return rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest)
}
