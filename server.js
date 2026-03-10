require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();

app.use(cors());
app.use(express.json({limit: "10mb"}));

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY;

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
    console.log(" WEBHOOK HIT");
    console.log(" BODY:", JSON.stringify(req.body, null, 2));

    const eventPayload = req.body.data || {};
    const eventAttributes = eventPayload.attributes || {};
    const eventType = (eventAttributes.type || "").toLowerCase();

    let resourceData = null;
    let resourceAttributes = null;

    if (eventAttributes.data && eventAttributes.data.attributes) {
      resourceData = eventAttributes.data;
      resourceAttributes = eventAttributes.data.attributes;
    } else if (eventPayload.attributes && eventPayload.attributes.data) {
      resourceData = eventPayload.attributes.data;
      resourceAttributes = eventPayload.attributes.data.attributes || null;
    } else if (eventPayload.attributes) {
      resourceData = eventPayload;
      resourceAttributes = eventPayload.attributes || null;
    }

    console.log(" eventType:", eventType);
    console.log(
        "resourceAttributes:",
        JSON.stringify(resourceAttributes, null, 2),
    );

    if (!resourceAttributes) {
      console.log(" No resourceAttributes found");
      return res.status(200).json({received: true, ignored: true});
    }

    const metadata = resourceAttributes.metadata || {};
    const hotelId = metadata.hotelId;
    const bookingId = metadata.bookingId;
    const paymentId = metadata.paymentId;

    console.log(" metadata:", metadata);
    console.log(" parsed ids:", {hotelId, bookingId, paymentId});

    if (!hotelId || !bookingId || !paymentId) {
      console.log(" Missing metadata IDs");
      return res.status(200).json({received: true, ignored: true});
    }

    const status = (resourceAttributes.status || "").toLowerCase();
    console.log(" status:", status);

    const amount =
      typeof resourceAttributes.amount === "number" ?
      resourceAttributes.amount / 100 :
      null;

    let reference = null;

    if (
      Array.isArray(resourceAttributes.payments) &&
      resourceAttributes.payments.length > 0 &&
      resourceAttributes.payments[0] &&
      resourceAttributes.payments[0].id
    ) {
      reference = resourceAttributes.payments[0].id;
    } else if (resourceData && resourceData.id) {
      reference = resourceData.id;
    }

    const isSucceeded =
      status === "succeeded" ||
      status === "paid" ||
      eventType === "payment.paid" ||
      eventType === "payment_intent.succeeded" ||
      eventType === "source.chargeable" ||
      eventType === "payment_intent.payment_attempted";

    console.log("🔥 isSucceeded:", isSucceeded);

    if (!isSucceeded) {
      console.log("❌ Not a success event");
      return res.status(200).json({
        received: true,
        ignored: true,
        status,
        eventType,
      });
    }

    console.log(" about to save paid payment", {
      eventType,
      status,
      hotelId,
      bookingId,
      paymentId,
      amount,
      reference,
    });

    await db
        .collection("hotels")
        .doc(hotelId)
        .collection("bookings")
        .doc(bookingId)
        .collection("payments")
        .doc(paymentId)
        .set(
            {
              paymentId,
              method: "qrph",
              status: "paid",
              amountExpected: amount,
              amountPaid: amount,
              reference,
              paymongoPaymentIntentId:
              resourceData && resourceData.id ? resourceData.id : null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            {merge: true},
        );

    console.log("Firestore payment doc saved");

    return res.status(200).json({received: true, saved: true});
  } catch (error) {
    console.error(
        " WEBHOOK ERROR:",
        error.response ?
        JSON.stringify(error.response.data, null, 2) :
        error.message,
    );
    return res.status(500).json({error: "Webhook handler failed"});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

