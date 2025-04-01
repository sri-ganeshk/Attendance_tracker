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
                // **Skip Option: skip <shortform> <hours>**
                if (msgText.toLowerCase().startsWith("skip ")) {
                    const words = msgText.split(" ");
                    if (words.length === 3) {
                        const [, shortId, hoursStr] = words;
                        const skipHours = parseInt(hoursStr, 10);

                        if (isNaN(skipHours)) {
                            await sock.sendMessage(fromNumber, { text: "❌ Invalid hours. Please provide a numeric value. For example: skip 596 3" });
                            return;
                        }

                        // Retrieve stored credentials for the shortform
                        const userInfo = await dynamoDB.get({
                            TableName: userTable,
                            Key: { phoneNumber: fromNumber },
                        }).promise();
        
                        if (userInfo.Item) {
                            const matchingCredential = userInfo.Item.credentials.find(cred => cred.shortId === shortId);
        
                            if (matchingCredential) {
                                const { rollNumber, password } = matchingCredential;
        
                                try {
                                    // Call the skip API endpoint
                                    const response = await axios.get("https://a0qna69x15.execute-api.ap-southeast-2.amazonaws.com/dev/skip", {
                                        params: {
                                            student_id: rollNumber,
                                            password,
                                            hours: skipHours
                                        },
                                    });
        
                                    const data = response.data;
                                    let skipMessage = `✨ *Attendance Update* ✨\n\n` +
                                        `Original Attendance: ${data.original_attendance_percentage}%\n` +
                                        `New Attendance: ${data.new_attendance_percentage}%\n` +
                                        `Status: ${data.status} ✅\n\n`;
        
                                    if (data.status === "safe to skip") {
                                        skipMessage += `You can skip an additional ${data.hours_can_skip_after} hours. 👍`;
                                    } else if (data.status === "needs to attend more") {
                                        skipMessage += `You need ${data.additional_hours_needed_after} more hours to reach 75%. 📚`;
                                    }
        
                                    await sock.sendMessage(fromNumber, { text: skipMessage });
                                    console.log("Sent skip attendance data back to user.");
                                } catch (error) {
                                    console.error("Error fetching skip attendance data:", error);
                                    await sock.sendMessage(fromNumber, { text: "❌ Error fetching skip attendance. Please try again." });
                                }
                            } else {
                                await sock.sendMessage(fromNumber, { text: "❌ No matching short form found. Please check your shortform ID." });
                            }
                        } else {
                            await sock.sendMessage(fromNumber, { text: "❌ No saved credentials found. Please set up your short form first." });
                        }
                    } else {
                        await sock.sendMessage(fromNumber, { text: "❌ Invalid format. Use: skip <shortform> <hours>\nFor example: skip 596 3" });
                    }
                    return; // Exit early after handling the skip command
                }
                
                // **Method 1: Direct Roll Number and Password Handling**
                const words = msgText.split(" ");
                if (words.length === 2 && /^[0-9]/.test(words[0])) {
                    const [rollNumber, password] = words;

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

                        const attendanceMessage = `Hi ${roll_number}\n${totalAttendance}\n${todayAttendance}\n\n${skipInfo}\n\n${subjectTable}`;

                        await sock.sendMessage(message.key.remoteJid, { text: attendanceMessage });
                        console.log("Sent attendance data back to user.");
                    } catch (error) {
                        console.error("Error fetching attendance data:", error);
                        await sock.sendMessage(message.key.remoteJid, { text: "❌ Invalid roll_number or password\n\nFor further assistance, click here for help (https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)." });
                    }
                    return; // Exit early since we've handled Method 1
                }

                // **Method 2: Short form logic with validation**
                if (msgText.toLowerCase().startsWith("set ")) {
                    const [_, shortId, rollNumber, password] = msgText.split(" ");
                
                    if (shortId && rollNumber && password) {
                        try {
                            // Validate the roll number and password with the API
                            const response = await axios.get("https://a0qna69x15.execute-api.ap-southeast-2.amazonaws.com/dev/attendance", {
                                params: {
                                    student_id: rollNumber,
                                    password,
                                },
                            });
                
                            // If the API call succeeds, proceed to store the short form
                            const attendanceData = response.data;
                
                            // Fetch existing user data from DynamoDB
                            const userInfo = await dynamoDB.get({
                                TableName: userTable,
                                Key: { phoneNumber: fromNumber },
                            }).promise();
                
                            // Initialize the credentials array if it doesn't exist
                            let userCredentials = userInfo.Item ? userInfo.Item.credentials || [] : [];
                
                            // Check if the rollNumber already exists
                            const existingRollNumber = userCredentials.find(cred => cred.rollNumber === rollNumber);
                
                            if (existingRollNumber) {
                                // If rollNumber exists, return the shortId associated with it
                                await sock.sendMessage(fromNumber,  {
                                    text: `⚠️ *This roll number is already linked to the short form:* ${existingRollNumber.shortId}\n\n` +
                                          `➡️ *To delete this short form and create a new one, follow these steps:*\n` +
                                          `➡️ Type and send: *delete ${existingRollNumber.shortId}*\n\n` +
                                          `After deleting, you can create a new short form with the same roll number.\n\nFor further assistance, click here for help (https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing).`
                                });
                            } else {
                                // Check if the shortId already exists
                                const existingShortId = userCredentials.find(cred => cred.shortId === shortId);
                
                                if (existingShortId) {
                                    // Update the shortId's rollNumber and password with the new data
                                    existingShortId.rollNumber = rollNumber;
                                    existingShortId.password = password;
                                    await sock.sendMessage(fromNumber, { text: `Updated the short form ${shortId} with new roll number and password.` });
                                } else {
                                    // Append new credentials to the existing array
                                    userCredentials.push({ shortId, rollNumber, password });
                                    await sock.sendMessage(fromNumber, { text: `✅ You can now use this shortform: ${shortId} to get your attendance.\n\n➡️ To get all your shortform IDs, type: *shortforms*` });
                                }
                
                                // Update DynamoDB with the new credentials array
                                await dynamoDB.put({
                                    TableName: userTable,
                                    Item: {
                                        phoneNumber: fromNumber,
                                        credentials: userCredentials,
                                    },
                                }).promise();
                            }
                        } catch (error) {
                            console.error("Error validating credentials:", error);
                            await sock.sendMessage(fromNumber, { text: "❌ Invalid roll number or password. Please try again." });
                        }
                    } else {
                        await sock.sendMessage(fromNumber, { text: "❌ Invalid format. Use: set <short_id> <roll_number> <password>\n\nFor further assistance, click here for help (https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)." });
                    }
                    return; // Exit early since we've handled the set command
                }
                
                // Handle retrieval by shortId
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

                        const attendanceMessage = `Hi ${roll_number}\n${totalAttendance}\n${todayAttendance}\n\n${skipInfo}\n\n${subjectTable}`;

                        await sock.sendMessage(message.key.remoteJid, { text: attendanceMessage });
                        console.log("Sent attendance data back to user.");
                    } catch (error) {
                        console.error("Error fetching attendance data:", error);
                        await sock.sendMessage(message.key.remoteJid, { text: "❌ Error fetching attendance. Please try again." });
                    }
                } else {
                    // **Display All Shortforms**
                    if (msgText.toLowerCase() === "shortforms") {
                        if (userInfo.Item && userInfo.Item.credentials.length > 0) {
                            let shortformMessage = "📋 *Your Saved Short Forms:*\n";
                            userInfo.Item.credentials.forEach(cred => {
                                shortformMessage += `• Short ID: ${cred.shortId} - Roll Number: ${cred.rollNumber}\n`;
                            });
                            shortformMessage += `\n➡️ To delete a shortform, type: delete <shortform_id>\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)`;
                            await sock.sendMessage(fromNumber, { text: shortformMessage });
                        } else {
                            await sock.sendMessage(fromNumber, { text: "❌ You have no saved short forms.\n\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)" });
                        }
                        return; // Exit early after showing short forms
                    }

                    // **Delete a Shortform**
                    if (msgText.toLowerCase().startsWith("delete ")) {
                        const shortIdToDelete = msgText.split(" ")[1];
                        if (shortIdToDelete) {
                            if (userInfo.Item && userInfo.Item.credentials.length > 0) {
                                const updatedCredentials = userInfo.Item.credentials.filter(cred => cred.shortId !== shortIdToDelete);
                                
                                if (updatedCredentials.length < userInfo.Item.credentials.length) {
                                    await dynamoDB.put({
                                        TableName: userTable,
                                        Item: {
                                            phoneNumber: fromNumber,
                                            credentials: updatedCredentials,
                                        },
                                    }).promise();
                                    await sock.sendMessage(fromNumber, { text: `✅ Shortform ${shortIdToDelete} has been deleted.` });
                                } else {
                                    await sock.sendMessage(fromNumber, { text: `❌ No shortform found with the ID: ${shortIdToDelete}\n\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)` });
                                }
                            } else {
                                await sock.sendMessage(fromNumber, { text: "❌ You have no saved short forms to delete.\n\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)" });
                            }
                        } else {
                            await sock.sendMessage(fromNumber, { text: "❌ Invalid format. Use: delete <short_id>\n\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)" });
                        }
                        return; // Exit after handling delete
                    }

                    // **Send Default Message if Command Not Recognized**
                    await sock.sendMessage(message.key.remoteJid, {
                        text: `👋 *Hi there!*\n\n🤖 *Welcome to the Attendance Bot* for our college.\n\nYou can use it in two ways:\n*Method 1: Quick Data*\nSend your *roll number* followed by your *password* to get attendance.\n_Example:_\n\`22L31A0596 password\`\n\n*Method 2: Short Form*\nSave a short form for easier use.\nTo save:\n\`set short_form roll_number password\`\n_Example:_\n\`set 596 22L31A0596 password\`\nAfter saving, just send the short form:\n_Example:_\n\`596\`\n\n*Skip Option:*\nTo check your attendance after skipping hours, send:\n\`skip <shortform> <hours>\`\n_Example:_\n\`skip 596 3\`\n\n📋 *Tips:*\n- Check your inputs carefully.\n- Use the short form to save time next time!\n- You can see all your short forms with keyword *shortforms*\n\nFor help: [Link](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing)\n\nEnjoy! 😊`
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
