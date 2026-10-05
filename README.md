# Chatturai Outreach

Camp-based cold email system. Apne mailboxes, apna server, koi third-party tool nahi.

---

## Railway pe deploy (15 minute)

### 1. Postgres add karo
Railway project → **New** → **Database** → **Add PostgreSQL**.

### 2. Yeh code deploy karo
Folder ko GitHub repo me daalo, phir Railway → **New** → **GitHub Repo** → repo select.
(Ya Railway CLI se: `railway up`)

### 3. Variables set karo
Service → **Variables** → yeh 3 add karo:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Railway khud de dega — Postgres service se link karo |
| `ENCRYPTION_KEY` | 64 hex characters, neeche command se banao |
| `APP_PASSWORD` | Jo password daal ke aap app khologe |

`ENCRYPTION_KEY` banane ke liye:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Yeh key kahin safe likh lo.** Mailbox passwords isi se encrypt hote hain. Key badli to
sab mailboxes dobara add karne padenge.

### 4. Deploy
Railway khud build karega. Pehli baar chalte hi database tables ban jaate hain.
Service → **Settings** → **Generate Domain** → wahan se app khul jayega.

---

## Gmail / Workspace accounts — SMTP ke bina

Google accounts password ke bajaye OAuth se judte hain. Yeh HTTPS pe chalta hai, isliye
un hosts pe bhi kaam karta hai jahan outbound SMTP block hai (Railway Hobby jaise).

**Ek baar ka setup:**

1. console.cloud.google.com pe ek project banao
2. **Gmail API** enable karo
3. **OAuth consent screen** → External → apne accounts ko **Test users** me add karo
4. **Credentials** → Create OAuth client ID → **Web application**
5. Authorized redirect URI me yeh daalo:
   `<APP_URL>/api/mailboxes/gmail/callback`
6. App ke variables me daalo: `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

Uske baad **Mailboxes → Connect a Google account**. Har account ek baar Google pe
approve karna hoga. Password kahin store nahi hota — sirf ek refresh token, woh bhi
encrypted.

**Gmail ki limits:** consumer Gmail ~500/day, Workspace ~2,000/day. Hum 5-10 per
mailbox bhejte hain, to limit ke aas-paas bhi nahi jaate.

---

## Pehli baar kya karna hai

**1. Mailboxes add karo** — "Add many" button se sab ek saath paste kar do:

```
nitish@chatturai.studio, password123
akash@chatturai.studio, password456
hello@getchatturai.com, password789
```

SMTP/IMAP host neeche ek baar bhar do, sab pe lag jayega. BigRock/Titan ke liye
aam taur pe `smtp.titan.email` (port 465) aur `imap.titan.email` (port 993) hota hai —
apne panel se confirm kar lena.

**2. Campaign banao** — naam, sending days, time window, aur kaunse mailboxes use karne hain.

**3. Sequence likho** — 4 mails. Pehla mail + 3 follow-ups.

**4. CSV import karo** — Leads tab se. Column mapping screen khud guess kar leti hai.

**5. Start** dabao. Start se pehle system check karta hai ki mailbox juda hai, template
bhara hai, aur leads hain — teenon me se kuch missing hua to saaf bata dega.

---

## Template likhne ka tarika

```
Hi {{first_name|there}},

{Main dekh raha tha|Aapki site dekhi} ki {{company}} brand films banwa raha hai.

Hum end-to-end AI cinematic production karte hain — script se final cut tak.

Is hafte 15 minute baat ho sakti hai?
```

- `{{first_name}}` — CSV ka koi bhi column
- `{{first_name|there}}` — khali ho to "there" lag jayega
- `{Hi|Hello|Hey}` — har mail me randomly ek chunega, isse do mail same nahi bante

Signature aur opt-out line system khud jodta hai — template me mat likhna.

---

## Jo system apne aap sambhalta hai

- **Reply aate hi follow-up band** — lead ka poora sequence ruk jaata hai
- **Ek lead = ek mailbox** — sequence bhar wahi mailbox, warna thread toot jaata hai
- **Warmup ramp** — naya mailbox day 1 pe 5 mails, 3 hafte me full speed
- **Bounce guard** — bounce rate limit cross hua to campaign khud pause
- **Hard bounce → blocklist** — woh address dobara kabhi mail nahi payega
- **"stop" reply → blocklist** — har campaign me se hat jayega
- **Out of office ≠ reply** — sequence 7 din ke liye ruk jaata hai, band nahi hota
- **Mailbox 5 baar fail** → pool se bahar, baaki mailboxes chalte rehte hain

Kuch bhi galat hua to **Today** screen pe plain language me dikhega, error log me nahi.

---

## Settings jo matter karti hain

**Gap between mails** — 45 se 150 second. Isse kam mat karo. 8 ghante ki window me
yeh lagbhag 300 mails/day deta hai. 500 chahiye to window 10 ghante karo ya gap
30-90 second.

**Daily limit per mailbox** — 35. Isse upar mat jao chahe BigRock allow kare.

**Bounce guard** — 5%. Cross hua to campaign apne aap ruk jayegi.

---

## Local pe chalana (testing)

```bash
npm install
cp .env.example .env     # values bhar do
npm start
```

Tests:

```bash
node test.js         # logic — templates, classify, schedule, warmup
node test-e2e.js     # poora send path ek fake SMTP server ke against
```

---

## Environment variables

| Variable | Zaroori | Default | Kya karta hai |
|---|---|---|---|
| `DATABASE_URL` | haan | — | Postgres connection string |
| `ENCRYPTION_KEY` | haan | — | 64 hex chars, mailbox passwords ke liye |
| `APP_PASSWORD` | haan | — | App kholne ka password |
| `RUN_WORKER` | nahi | `true` | `false` karo agar worker alag service pe chalana ho |
| `SCHEDULER_INTERVAL_MS` | nahi | `30000` | Kitni der me sending check ho |
| `IMAP_INTERVAL_MS` | nahi | `300000` | Kitni der me replies check hon |
| `MAX_SENDS_PER_TICK` | nahi | `12` | Ek tick me max kitne mail |

---

## Jo system nahi karta

**Warmup network.** System naye mailbox ko dheere ramp karta hai, lekin Gmail/Outlook ke
real inboxes tak mail bhej kar reputation nahi banata — uske liye hazaron mailboxes ka
network chahiye. Uske liye Warmy ya Mailreach jaisa ek alag tool lagega (~$30/month),
ya manual warmup karna padega.

**SPF, DKIM, DMARC.** Yeh aapke DNS me lagte hain, system me nahi. Inke bina mail spam
me hi jayegi chahe baaki sab perfect ho.

**Email verification.** List purani ho to system ke bahar verify karao. Bounce 2% cross
hua to naye domains pehle hafte me hi burn ho jayenge.
