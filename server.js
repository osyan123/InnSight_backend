require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json({limit: "10mb"}));

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY;

if (!PAYMONGO_SECRET_KEY) {
  throw new Error("Missing PAYMONGO_SECRET_KEY environment variable");
}

function paymongoHeaders() {
  return {
    Authorization:
      "Basic " +
      Buffer.from(PAYMONGO_SECRET_KEY + ":").toString("base64"),
    "Content-Type": "application/json",
  };
}

app.get("/", (req, res) => {
  res.json({message: "InnSight PayMongo backend is running"});
});

app.get("/paymongo-webhook", (req, res) => {
  res.send("PayMongo webhook route is alive");
});

app.post("/create-qr-payment", async (req, res) => {
  try {
    const {hotelId, bookingId, paymentId, amount} = req.body;

    if (!hotelId || !bookingId || !paymentId || !amount) {
      return res.status(400).json({
        error: "hotelId, bookingId, paymentId, and amount are required",
      });
    }

    const amountInCentavos = Math.round(Number(amount) * 100);

    const paymentIntentResponse = await axios.post(
      "https://api.paymongo.com/v1/payment_intents",
      {
        data: {
          attributes: {
            amount: amountInCentavos,
            currency: "PHP",
            capture_type: "automatic",
            payment_method_allowed: ["qrph"],
            metadata: {
              hotelId,
              bookingId,
              paymentId,
            },
          },
        },
      },
      {
        headers: paymongoHeaders(),
      },
    );

    const paymentIntentId = paymentIntentResponse.data.data.id;

    const paymentMethodResponse = await axios.post(
      "https://api.paymongo.com/v1/payment_methods",
      {
        data: {
          attributes: {
            type: "qrph",
            billing: {
              name: "InnSight Guest",
              email: "guest@example.com",
            },
          },
        },
      },
      {
        headers: paymongoHeaders(),
      },
    );

    const paymentMethodId = paymentMethodResponse.data.data.id;

    const attachResponse = await axios.post(
      `https://api.paymongo.com/v1/payment_intents/${paymentIntentId}/attach`,
      {
        data: {
          attributes: {
            payment_method: paymentMethodId,
          },
        },
      },
      {
        headers: paymongoHeaders(),
      },
    );

    console.log(
      "ATTACH RESPONSE FULL:",
      JSON.stringify(attachResponse.data, null, 2),
    );

    const attributes = attachResponse.data.data.attributes || {};
    const nextAction = attributes.next_action || {};
    const qrImageUrl =
      nextAction.code && nextAction.code.image_url ?
        nextAction.code.image_url :
        "";

    const paymentRef = db
      .collection("hotels")
      .doc(hotelId)
      .collection("bookings")
      .doc(bookingId)
      .collection("payments")
      .doc(paymentId);

    await paymentRef.set(
      {
        paymentId,
        bookingId,
        hotelId,
        method: "online",
        status: "pending",
        amountExpected: Number(amount),
        amountPaid: 0,
        amountReceived: 0,
        change: 0,
        reference: null,
        paymongoPaymentIntentId: paymentIntentId,
        paymongoPaymentMethodId: paymentMethodId,
        paymentIntentStatus: attributes.status || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    console.log("CREATE QR DOC PATH:", paymentRef.path);

    return res.status(200).json({
      qrImageUrl,
      paymongoPaymentIntentId: paymentIntentId,
      paymongoPaymentMethodId: paymentMethodId,
      paymentIntentStatus: attributes.status || null,
      bookingId,
      paymentId,
    });
  } catch (error) {
    console.error(
      "create-qr-payment error:",
      error.response ?
        JSON.stringify(error.response.data, null, 2) :
        error.message,
    );

    return res.status(500).json({
      error: "Failed to create QR payment",
      details: error.response ? error.response.data : error.message,
    });
  }
});

app.post("/paymongo-webhook", async (req, res) => {
  try {
    console.log("========== WEBHOOK HIT ==========");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("================================");

    const data = req.body.data || {};
    const attributes = data.attributes || {};
    const metadata = attributes.metadata || {};

    const hotelId = metadata.hotelId;
    const bookingId = metadata.bookingId;
    const paymentId = metadata.paymentId;

    const status = (attributes.status || "").toLowerCase();
    const eventType = (req.body.data?.attributes?.type || "").toLowerCase();

    const amount =
      typeof attributes.amount === "number" ?
        attributes.amount / 100 :
        null;

    let reference = null;

    if (
      attributes.payments &&
      Array.isArray(attributes.payments) &&
      attributes.payments.length > 0 &&
      attributes.payments[0].id
    ) {
      reference = attributes.payments[0].id;
    }

    console.log("METADATA:");
    console.log("hotelId:", hotelId);
    console.log("bookingId:", bookingId);
    console.log("paymentId:", paymentId);
    console.log("status:", status);
    console.log("WEBHOOK EVENT TYPE:", eventType);
    console.log("WEBHOOK STATUS:", status);

    if (!hotelId || !bookingId || !paymentId) {
      console.log("Missing metadata IDs");
      return res.status(200).json({received: true, ignored: true});
    }

    const isSuccess =
      status === "succeeded" ||
      status === "paid" ||
      eventType === "payment.paid" ||
      eventType === "payment_intent.succeeded";

    if (!isSuccess) {
      console.log("Payment not yet successful");
      return res.status(200).json({received: true, ignored: true});
    }

    const paymentRef = db
      .collection("hotels")
      .doc(hotelId)
      .collection("bookings")
      .doc(bookingId)
      .collection("payments")
      .doc(paymentId);

    console.log("UPDATING FIRESTORE DOC:", paymentRef.path);

    await paymentRef.set(
      {
        status: "paid",
        amountPaid: amount,
        amountReceived: amount,
        reference: reference,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    console.log("PAYMENT UPDATED SUCCESSFULLY");

    return res.status(200).json({
      received: true,
      updated: true,
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({error: "Webhook failed"});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
