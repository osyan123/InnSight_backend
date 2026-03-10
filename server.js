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

    console.log("eventType:", eventType);
    console.log(
        "resourceAttributes:",
        JSON.stringify(resourceAttributes, null, 2),
    );

    if (!resourceAttributes) {
      console.log("No resourceAttributes found");
      return res.status(200).json({received: true, ignored: true});
    }

    let metadata = resourceAttributes.metadata || {};
    let hotelId = metadata.hotelId || null;
    let bookingId = metadata.bookingId || null;
    let paymentId = metadata.paymentId || null;

    const status = (resourceAttributes.status || "").toLowerCase();
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

    let paymentIntentId = null;

    if (resourceAttributes.payment_intent_id) {
      paymentIntentId = resourceAttributes.payment_intent_id;
    } else if (
      resourceAttributes.payment_intent &&
      typeof resourceAttributes.payment_intent === "object"
    ) {
      paymentIntentId = resourceAttributes.payment_intent.id || null;
    } else if (
      resourceAttributes.source &&
      typeof resourceAttributes.source === "object"
    ) {
      paymentIntentId = resourceAttributes.source.id || null;
    } else if (
      resourceAttributes.payments &&
      Array.isArray(resourceAttributes.payments) &&
      resourceAttributes.payments.length > 0 &&
      resourceAttributes.payments[0] &&
      resourceAttributes.payments[0].attributes &&
      resourceAttributes.payments[0].attributes.payment_intent_id
    ) {
      paymentIntentId =
        resourceAttributes.payments[0].attributes.payment_intent_id;
    } else if (resourceData && resourceData.id) {
      paymentIntentId = resourceData.id;
    }

    console.log("metadata:", metadata);
    console.log("parsed ids:", {hotelId, bookingId, paymentId});
    console.log("status:", status);
    console.log("paymentIntentId:", paymentIntentId);
    console.log("reference:", reference);

    if (!hotelId || !bookingId || !paymentId) {
      console.log(
          "Metadata incomplete. Trying lookup by paymongoPaymentIntentId...",
      );

      if (paymentIntentId) {
        const cg = await db
            .collectionGroup("payments")
            .where("paymongoPaymentIntentId", "==", paymentIntentId)
            .limit(1)
            .get();

        if (!cg.empty) {
          const doc = cg.docs[0];
          const path = doc.ref.path.split("/");

          if (path.length >= 6) {
            hotelId = path[1];
            bookingId = path[3];
            paymentId = path[5];
          }

          console.log("Resolved payment doc via collectionGroup:", {
            hotelId,
            bookingId,
            paymentId,
            path: doc.ref.path,
          });
        }
      }
    }

    if (!hotelId || !bookingId || !paymentId) {
      console.log("Still missing IDs after lookup");
      return res.status(200).json({received: true, ignored: true});
    }

    const isSucceeded =
      status === "succeeded" ||
      status === "paid" ||
      eventType === "payment.paid" ||
      eventType === "payment_intent.succeeded";

    console.log("isSucceeded:", isSucceeded);

    if (!isSucceeded) {
      console.log("Not a success event");
      return res.status(200).json({
        received: true,
        ignored: true,
        status,
        eventType,
      });
    }

    const paymentRef = db
        .collection("hotels")
        .doc(hotelId)
        .collection("bookings")
        .doc(bookingId)
        .collection("payments")
        .doc(paymentId);

    console.log("=== WEBHOOK SAVE ===");
    console.log("hotelId:", hotelId);
    console.log("bookingId:", bookingId);
    console.log("paymentId:", paymentId);
    console.log(
        `hotels/${hotelId}/bookings/${bookingId}/payments/${paymentId}`,
    );
    console.log("====================");

    await paymentRef.set(
        {
          paymentId,
          method: "online",
          status: "paid",
          amountExpected: amount,
          amountPaid: amount,
          amountReceived: amount,
          change: 0,
          reference,
          paymongoPaymentIntentId: paymentIntentId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
    );

    console.log("Firestore payment doc saved successfully");

    return res.status(200).json({received: true, saved: true});
  } catch (error) {
    console.error(
        "WEBHOOK ERROR:",
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
