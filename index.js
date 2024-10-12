const AWS = require('aws-sdk');
const { DisconnectReason } = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;
const axios = require("axios"); // For sending requests to Flask API
const useDynamoDBAuthState = require("./dynamoAuthState");

// Configure AWS DynamoDB client
const dynamoDB = new AWS.DynamoDB.DocumentClient({
    region: 'ap-southeast-2', // Adjust region accordingly
});

async function connectionLogic() {
    try {
        console.log("Connecting to DynamoDB...");

        const authTable = "auth_info_baileys"; // DynamoDB table for auth state
        const userTable = "user_info"; // DynamoDB table for user data

        // Use the DynamoDB for WhatsApp authentication state
        const { state, saveCreds } = await useDynamoDBAuthState(authTable);

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
                    connectionLogic(); // Reconnect on failure, unless logged out
                }
            }
        });

        // Handle incoming messages
        sock.ev.on("messages.upsert", async (messageInfoUpsert) => {
            const message = messageInfoUpsert.messages[0];

            if (message.key.fromMe) {
                return; // Do nothing for messages sent by the bot itself
            }

            // Log the incoming message to the console
            console.log("Received message:", message);
        
            // Check if it's a text message, either in conversation or extendedTextMessage format
            const msgText = message.message?.conversation?.trim() || message.message?.extendedTextMessage?.text?.trim();
            const fromNumber = message.key.remoteJid;
        
            if (msgText) {
                // Handle "set" command or shortId as per your previous logic
                if (msgText.startsWith("set ")) {
                    const [_, shortId, rollNumber, password] = msgText.split(" ");
        
                    if (shortId && rollNumber && password) {
                        // Fetch existing user data from DynamoDB
                        const userInfo = await dynamoDB.get({
                            TableName: userTable,
                            Key: { phoneNumber: fromNumber },
                        }).promise();
        
                        // Initialize the credentials array if it doesn't exist
                        const userCredentials = userInfo.Item ? userInfo.Item.credentials || [] : [];
        
                        // Append new credentials to the existing array
                        userCredentials.push({ shortId, rollNumber, password });
        
                        // Update DynamoDB with the new credentials array
                        await dynamoDB.put({
                            TableName: userTable,
                            Item: {
                                phoneNumber: fromNumber,
                                credentials: userCredentials,
                            },
                        }).promise();
        
                        await sock.sendMessage(fromNumber, { text: `U can now use this shortform to get ur data ${shortId}` });
                    } else {
                        await sock.sendMessage(fromNumber, { text: "Invalid format. Use: set <short_id> <roll_number> <password>" });
                    }
                    return;
                }
        
                // Check if the message is a shortId to retrieve saved credentials
                const userInfo = await dynamoDB.get({
                    TableName: userTable,
                    Key: { phoneNumber: fromNumber },
                }).promise();
        
                let rollNumber, password;
        
                if (userInfo.Item) {
                    // Find the credentials matching the shortId
                    const matchingCredential = userInfo.Item.credentials.find(cred => cred.shortId === msgText);
        
                    if (matchingCredential) {
                        rollNumber = matchingCredential.rollNumber;
                        password = matchingCredential.password;
                    }
                }
        
                if (rollNumber && password) {
                    try {
                        // Send roll number and password to Flask API
                        const response = await axios.get("https://a0qna69x15.execute-api.ap-southeast-2.amazonaws.com/dev/attendance", {
                            params: {
                                student_id: rollNumber,
                                password,
                            },
                        });
        
                        const attendanceData = response.data;
                        const { roll_number, subjectwise_summary, total_info, attendance_summary } = attendanceData;
        
                        // Build the table of subject-wise attendance
                        let subjectTable = "Subject-wise Attendance:\n";
        
                        subjectwise_summary.forEach((subject) => {
                            subjectTable += `${subject.subject_name}  ${subject.attended_held}   ${subject.percentage}%\n`;
                        });
        
                        const totalAttendance = `Total: ${total_info.total_attended}/${total_info.total_held} (${total_info.total_percentage}%)\n`;
        
                        let skipInfo = "";
                        if (total_info.hours_can_skip) {
                            skipInfo = `You can skip ${total_info.hours_can_skip} hours and still maintain above 75%.`;
                        } else if (total_info.additional_hours_needed) {
                            skipInfo = `You need ${total_info.additional_hours_needed} more hours to maintain above 75%.`;
                        }
        
                        let todayAttendance = "Today's Attendance:\n";
                        if (attendance_summary.length > 0 && attendance_summary[0].subject) {
                            attendance_summary.forEach((attendance) => {
                                todayAttendance += `${attendance.subject}: ${attendance.attendance_today}\n`;
                            });
                        } else {
                            todayAttendance += attendance_summary[0].message;
                        }
        
                        const attendanceMessage = `Hi${roll_number}\n${totalAttendance}\n${todayAttendance}\n\n${skipInfo}\n\n${subjectTable}`;
        
                        await sock.sendMessage(message.key.remoteJid, { text: attendanceMessage });
        
                        console.log("Sent attendance data back to user.");
                    } catch (error) {
                        console.error("Error fetching attendance data:", error);
                        await sock.sendMessage(message.key.remoteJid, { text: "Error fetching attendance. Please try again." });
                    }
                } else {
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `👋 *Hi there!*\n\n🤖 *Welcome to the Attendance Bot* for our college.\n\nYou can use it in two ways:\n*Method 1: Quick Data*\nSend your *roll number* followed by your *password* to get attendance.\n_Example:_\n\`22L31A0596 password\`\n\n*Method 2: Short Form*\nSave a short form for easier use.\nTo save:\n\`set short_form roll_number password\`\n_Example:_\n\`set 596 22L31A0596 password\`\nAfter saving, just send the short form:\n_Example:_\n\`596\`\n\n📋 *Tips:*\n- Check your inputs carefully.\n- Use the short form to save time next time!\n\nEnjoy! 😊`
                    });
                }
            }
        });
        

        sock.ev.on("creds.update", saveCreds);

    } catch (err) {
        console.error("Error connecting to DynamoDB or initializing WhatsApp socket:", err);
    }
}

// Start the connection
connectionLogic();
