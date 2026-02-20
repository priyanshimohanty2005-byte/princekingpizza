require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


// ================== MONGODB ==================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error(err));


// ================== MODELS ==================

const orderSchema = new mongoose.Schema({
  orderType: String,
  customerName: String,
  registrationNumber: String,
  mobile: String,
  tableNumber: String,
  address: String,
  items: Array,
  total: Number,
  status: { type: String, default: "new" }
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

const managerSchema = new mongoose.Schema({
  username: String,
  password: String
});

const Manager = mongoose.model("Manager", managerSchema);


// ================== RAZORPAY ==================
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});


// ================== PAYMENT ROUTES ==================

app.post("/api/payments/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR"
    });

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Payment order creation failed" });
  }
});


app.post("/api/payments/verify-and-create-order", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderPayload
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.json({ success: false });
    }

    const total = orderPayload.items.reduce(
      (sum, i) => sum + i.price * i.qty,
      0
    );

    const newOrder = await Order.create({
      ...orderPayload,
      total
    });

    io.emit("newOrder", newOrder);

    res.json({ success: true, order: newOrder });

  } catch (err) {
    res.status(500).json({ success: false });
  }
});


// ================== ORDER ROUTES ==================

app.get("/api/orders", async (req, res) => {
  const { date } = req.query;

  const start = new Date(date);
  const end = new Date(date);
  end.setDate(end.getDate() + 1);

  const orders = await Order.find({
    createdAt: { $gte: start, $lt: end }
  }).sort({ createdAt: -1 });

  res.json(orders);
});


app.patch("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true }
  );

  io.emit("orderUpdated", order);
  res.json(order);
});


// ================== DASHBOARD ==================

app.get("/api/dashboard/sales", async (req, res) => {
  const { period, date } = req.query;

  const start = new Date(date);
  let end = new Date(date);

  if (period === "week") end.setDate(start.getDate() + 7);
  else if (period === "month") end.setMonth(start.getMonth() + 1);
  else end.setDate(start.getDate() + 1);

  const orders = await Order.find({
    createdAt: { $gte: start, $lt: end },
    status: { $ne: "deleted" }
  });

  const total = orders.reduce((s, o) => s + o.total, 0);

  res.json({ total, count: orders.length });
});


app.get("/api/dashboard/topdish", async (req, res) => {
  const { date } = req.query;

  const start = new Date(date);
  const end = new Date(date);
  end.setDate(end.getDate() + 1);

  const orders = await Order.find({
    createdAt: { $gte: start, $lt: end }
  });

  const dishCount = {};

  orders.forEach(o => {
    o.items.forEach(i => {
      dishCount[i.name] = (dishCount[i.name] || 0) + i.qty;
    });
  });

  const top = Object.entries(dishCount)
    .sort((a, b) => b[1] - a[1])[0];

  if (!top) return res.json(null);

  res.json({ _id: top[0], count: top[1] });
});


// ================== MANAGER LOGIN ==================

app.post("/api/manager/login", async (req, res) => {
  const { username, password } = req.body;

  const manager = await Manager.findOne({ username, password });

  if (!manager) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  res.json({ success: true });
});


app.post("/api/manager/change-credentials", async (req, res) => {
  const { currentUser, currentPassword, newUser, newPassword } = req.body;

  const manager = await Manager.findOne({
    username: currentUser,
    password: currentPassword
  });

  if (!manager) {
    return res.status(401).json({ success: false });
  }

  manager.username = newUser;
  manager.password = newPassword;
  await manager.save();

  res.json({ success: true });
});


// ================== MENU UPDATE ==================

app.post("/update-menu", async (req, res) => {
  try {
    const menuPath = path.join(__dirname, "public", "menu.json");
    fs.writeFileSync(menuPath, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});


// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Prince King Pizza Server Running on port " + PORT);
});
