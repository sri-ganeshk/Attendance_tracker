const {
    DisconnectReason,
    useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;
const axios = require("axios"); // For sending requests to Flask API
const mongoURL = "mongodb+srv://ganeshknsml:Gan2004@cluster0.laz5d.mongodb.net/?retryWrites=true&w=majority";
const { MongoClient } = require("mongodb");
const useMongoDBAuthState = require("./mongoAuthState");

async function connectionLogic() {
    const mongoClient = new MongoClient(mongoURL);

    try {
        await mongoClient.connect();
        console.log("Connected to MongoDB!");

        const collection = mongoClient.db("whatsapp_api").collection("auth_info_baileys");

        const { state, saveCreds } = await useMongoDBAuthState(collection);

        const sock = makeWASocket({
            printQRInTerminal: true,
            auth: state,
        });

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update || {};

            if (qr) {
                console.log(qr); // Log QR code to terminal
            }

            if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    connectionLogic();
                }
            }
        });

        // Handle incoming message updates
        sock.ev.on("messages.upsert", async (messageInfoUpsert) => {
            const message = messageInfoUpsert.messages[0];
            if (message.message?.conversation) {
                const msgText = message.message.conversation.trim();
                console.log("Received message:", msgText);

                // Check if message contains student ID and password in the expected format
                const [student_id, password] = msgText.split(" "); // Assuming format: "<student_id> <password>"
                if (student_id && password) {
                    try {
                        // Send student ID and password to Flask API
                        const response = await axios.get("http://localhost:3000/attendance", {
                            params: {
                                student_id,
                                password,
                            },
                        });

                        const attendanceData = response.data;

                        // Send the attendance data back via WhatsApp
                        const attendanceMessage = `Attendance Data:\n${JSON.stringify(attendanceData, null, 2)}`;
                        await sock.sendMessage(message.key.remoteJid, {
                            text: attendanceMessage,
                        });

                        console.log("Sent attendance data back to user.");
                    } catch (error) {
                        console.error("Error fetching attendance data:", error);

                        await sock.sendMessage(message.key.remoteJid, {
                            text: "Error fetching attendance. Please try again.",
                        });
                    }
                } else {
                    // Reply with error if format is wrong
                    await sock.sendMessage(message.key.remoteJid, {
                        text: "rollnumber password",
                    });
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);

    } catch (err) {
        console.error("Error connecting to MongoDB or initializing WhatsApp socket:", err);
    } finally {
        // Optional: Close the MongoDB connection here
        // await mongoClient.close();
    }
}

// Start the connection
connectionLogic();
