// server.js
// Fully automated digital product sales flow:
// 1. Customer clicks "Buy" -> Stripe Checkout Session created
// 2. Customer pays on Stripe's hosted page
// 3. Stripe sends a webhook -> we verify it, generate a secure one-time
//    download link, and email it automatically
// 4. Customer clicks the link in their inbox and downloads the file
//
// No manual intervention required at any step.

require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// In-memory token store. For production, swap this for a real database
// (Postgres, SQLite, Redis, etc.) so tokens survive server restarts.
const downloadTokens = new Map(); // token -> { file, expiresAt, used }

const PRODUCT = {
  name: process.env.PRODUCT_NAME || 'My Ebook',
  priceId: process.env.STRIPE_PRICE_ID, // created in Stripe Dashboard
  file: process.env.PRODUCT_FILE || 'sample-ebook.pdf', // filename in /files
};

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ---- Stripe webhook needs the RAW body, so it's registered BEFORE
// ---- express.json() and uses its own raw parser.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email;

      if (email) {
        try {
          await deliverProduct(email);
        } catch (err) {
          // Log but still return 200 so Stripe doesn't endlessly retry;
          // in production, send this failure to an alerting channel.
          console.error('Delivery failed for', email, err);
        }
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.static(__dirname));

// ---- Create a Checkout Session when the customer clicks "Buy Now"
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: PRODUCT.priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/success.html`,
      cancel_url: `${process.env.APP_URL}/cancel.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// ---- Generates a one-time secure link and emails it automatically
async function deliverProduct(email) {
  const token = crypto.randomBytes(24).toString('hex');
  downloadTokens.set(token, {
    file: PRODUCT.file,
    expiresAt: Date.now() + 1000 * 60 * 60 * 48, // 48 hours
    used: false,
  });

  const downloadUrl = `${process.env.APP_URL}/download/${token}`;

  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: `Your download: ${PRODUCT.name}`,
    html: `
      <p>Thanks for your purchase!</p>
      <p><a href="${downloadUrl}">Click here to download ${PRODUCT.name}</a></p>
      <p>This link expires in 48 hours and can be used once.</p>
    `,
  });

  console.log(`Delivered "${PRODUCT.name}" to ${email}`);
}

// ---- Secure, single-use, time-limited download endpoint
app.get('/download/:token', (req, res) => {
  const entry = downloadTokens.get(req.params.token);

  if (!entry) return res.status(404).send('Invalid or expired link.');
  if (entry.used) return res.status(410).send('This link has already been used.');
  if (Date.now() > entry.expiresAt) {
    downloadTokens.delete(req.params.token);
    return res.status(410).send('This link has expired.');
  }

  entry.used = true; // one-time use
  const filePath = path.join(__dirname,entry.file);

  if (!fs.existsSync(filePath)) {
    return res.status(500).send('File missing on server.');
  }

  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Store running on port ${PORT}`));
