import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import bodyParser from "body-parser";
import fs from "fs";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(bodyParser.json());

// Checkout session तयार करणे
app.get("/create-checkout-session", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "inr",
        product_data: { name: "सरकारी योजना ई-बुक" },
        unit_amount: 19900, // ₹199
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: "https://yourdomain.onrender.com/success",
    cancel_url: "https://yourdomain.onrender.com/cancel",
  });
  res.json({ id: session.id });
});

// Stripe Webhook
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const event = req.body;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const customerEmail = session.customer_details.email;

    // ई-बुक मेल पाठवा
    await resend.emails.send({
      from: "noreply@yourdomain.com",
      to: customerEmail,
      subject: "तुमचं ई-बुक तयार आहे",
      html: "<p>धन्यवाद! ई-बुक डाउनलोड करा:</p>",
      attachments: [
        {
          filename: "ebook.pdf",
          content: fs.readFileSync("./ebook.pdf").toString("base64"),
        }
      ]
    });
  }

  res.json({ received: true });
});

app.listen(3000, () => console.log("Server running on port 3000"));
