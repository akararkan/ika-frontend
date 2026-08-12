# Email verification — backend guide

The last two Security-checkup items ("Account recovery configured" +
"Email address verified") both read the same flag: `user.isEmailVerified()`
(`SecurityScoreService.java`). Today only an admin can set it
(`POST /admin/users/{id}/email/verify`). This guide adds the user-facing flow
that clears both items — worth **50 points** (30 + 20).

Everything needed already exists in the repo — this is wiring, not invention:

| Piece | Reuse from |
|---|---|
| 6-digit code, hashing, TTL, attempt caps | `security/otp` (`OtpService`, `OtpChallenge`, Redis pattern) |
| Delivery | `email/EmailService` (Resend sender, templates, throttle, send log) |
| Endpoint style + errors | `security/phone` (`PhoneService`, `SecurityController`) |
| The flag to set | `User.emailVerifiedAt` (already written by the admin path) |

---

## 1. The two endpoints (mirror the phone flow)

Both under `SecurityController`, both require `Authorization: Bearer <accessToken>`.

### Send the code

```
POST /api/v1/security/email/request
```

**No body.** The code goes to the account's own email — never let the client
pick the address (that would "verify" an address the user doesn't own).

→ `202 Accepted`, empty body. Like phone: 202 means *generated*, not *delivered*.

- Code: **6 digits**, expires in **15 minutes** (email is slower than SMS).
- If `emailVerifiedAt` is already set → `409 EMAIL_ALREADY_VERIFIED`.

### Verify the code

```
POST /api/v1/security/email/verify
Content-Type: application/json

{ "code": "255758" }
```

→ `200 OK`

```json
{ "verified": true, "email": "user@example.com" }
```

On success: set `user.setEmailVerifiedAt(now)`, write the audit row
(`AuditAction.EMAIL_VERIFY`, "Email verified by user"), save.

---

## 2. Implementation notes

**New purpose.** Add `EMAIL_VERIFY` to `OtpPurpose` — codes are purpose-scoped,
so an `EMAIL_CHANGE` code must not be replayable here (and vice versa).

**Challenge storage.** `OtpService` is phone-shaped (it runs `PhoneNormalizer`
on the destination). Two options:

- *Small:* a thin `EmailVerificationService` that copies the same pattern —
  hashed code in Redis at `otp:EMAIL_VERIFY:{sha256(email)}`, TTL 15 min,
  attempts counter, Postgres `OtpChallenge` row for audit. ~80 lines.
- *Bigger:* generalize `OtpService` to take an already-normalized destination.
  Only worth it if email-OTP login is planned.

Take the small one.

**Delivery.** `EmailService.sendAsync(...)` with a new `EmailTemplate` entry:

> Subject: `Your IRC verification code`
> Body: `Your verification code is 255758. It expires in 15 minutes.
> If you didn't request this, you can ignore this email.`

When `EmailService.isEnabled()` is false (no Resend key configured), log the
code to the console exactly like `LoggingSmsSender` does, so local testing
works the same way:

```
[EMAIL-DEV] to=user@example.com code=255758 purpose=EMAIL_VERIFY
```

**Limits — same numbers as phone:**

- 3 sends per account/hour, 10 per IP/hour → `429`
- **5 wrong codes** burns the challenge → request a new one
- single-use: a redeemed code cannot be replayed

**Registration hook (optional but cheap):** fire the same send on signup, so
new users arrive with a code already in their inbox.

---

## 3. Errors (standard envelope, stable `code`)

| HTTP | code | Meaning | Frontend UI |
|---|---|---|---|
| 400 | `OTP_INVALID` | wrong / expired / already-used — one code for all three, the human `message` says which | "Incorrect or expired code" + Resend |
| 409 | `EMAIL_ALREADY_VERIFIED` | flag already set | hide the card / show green state |
| 429 | rate limit | send or attempt budget exhausted | countdown, disable Resend |

Note there is no `EMAIL_INVALID` case — the address comes from the account,
not the request.

---

## 4. What the frontend does once this exists

(For the ika app — not part of the backend work.)

1. New "Verify your email" card in Settings → Security: one **Send code**
   button + a 6-digit input. Same UX as the phone card (30s resend cooldown,
   5-attempt hint).
2. `SCORE_ACTION` in `SecurityExtraPanel.jsx` gets entries for the
   `recovery` / `email_verified` check keys pointing at the new card —
   they're deliberately inert today because there is nothing to link to.
3. **Expose the flag.** Add `emailVerified` (boolean) to the profile/me
   response — today no DTO carries it, so the frontend can't render the
   card's verified/unverified state without guessing. One boolean on
   `UserResponse` is enough.

## 5. Definition of done

- [ ] `POST /security/email/request` → 202, code in console when mail is off
- [ ] `POST /security/email/verify` → 200, `emailVerifiedAt` set, audit row written
- [ ] Wrong code ×5 → challenge burned; expired → `OTP_INVALID`
- [ ] Second request after verify → `409 EMAIL_ALREADY_VERIFIED`
- [ ] `GET /settings/safety/score` (or wherever the checkup loads from) now
      returns all four checks passed → score **100**
- [ ] `emailVerified` visible on the me/profile DTO
