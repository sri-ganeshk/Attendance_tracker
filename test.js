const AWS = require("aws-sdk");
const { DisconnectReason } = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;
const axios = require("axios");
const useDynamoDBAuthState = require("./dynamoAuthState");

// Global constants
const authTable = "auth_info_baileys"; // For auth state
const userTable = "user_info"; // For user data
const ATTENDANCE_API =
  "https://a0qna69x15.execute-api.ap-southeast-2.amazonaws.com/dev/attendance";
const HELP_DOC_LINK =
  "https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing";

// Configure AWS DynamoDB client
const dynamoDB = new AWS.DynamoDB.DocumentClient({ region: "ap-southeast-2" });

async function whatsAppConnection() {
  try {
    console.log("Connecting to DynamoDB...");
    const { state, saveCreds } = await useDynamoDBAuthState(authTable);

    const sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update || {};
      if (qr) console.log("QR code:", qr);
      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        if (shouldReconnect) {
          whatsAppConnection(); // Reconnect on failure (recursively)
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
    return sock;
  } catch (err) {
    console.error(
      "Error connecting to DynamoDB or initializing WhatsApp socket:",
      err
    );
  }
}

async function logout(sock) {
  try {
    console.log("Logging out...");

    const {state, clearCreds} = await useDynamoDBAuthState(authTable);
    if(!state.creds)
      return;

    await clearCreds();
    console.log("credentials Cleared");

    if(sock){
      await sock.logout();
      console.log("Logged out.");
    }

    setTimeout(()=>{
      whatsAppConnection();
    },3000);
  } catch (error) {
    console.error("Error logging out:", error);
  }
}

async function sendMessage(sock, to, text) {
  try {
    await sock.sendMessage(to, { text });
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

function buildAttendanceMessage(data) {
  const { roll_number, total_info, subjectwise_summary, attendance_summary } =data;
  let message = `Hi, Roll Number: ${roll_number}\n`;
  message += `Total: ${total_info.total_attended}/${total_info.total_held} (${total_info.total_percentage}%)\n`;

  message +=
    total_info.total_percentage < 75
      ? `\nYou need to attend ${total_info.additional_hours_needed} more hours to reach 75%.`
      : `\nYou can skip ${total_info.hours_can_skip} hours and still maintain above 75%.`;

  if (attendance_summary.length > 0 && attendance_summary[0].subject) {
    message += `\n\nToday's Attendance:\n`;
    attendance_summary.forEach(({ subject, attendance_today }) => {
      message += `${subject}: ${attendance_today}\n`;
    });
  } else {
    message += `\n${attendance_summary[0].message}\n`;
  }

  message += `\nSubject-wise Attendance:\n`;
  subjectwise_summary.forEach(({ subject_name, attended_held, percentage }) => {
    message += `${subject_name}: ${attended_held} (${percentage}%)\n`;
  });
  return message;
}

async function fetchAttendanceData(rollNumber, password) {
  try {
    const response = await axios.get(ATTENDANCE_API, {
      params: { student_id: rollNumber, password },
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching attendance data:", error);
  }
}

async function handleDirectCommand(rollNumber, password, fromNumber, sock) {
  try {
    const response = await fetchAttendanceData(rollNumber, password);
    const attendanceMessage = buildAttendanceMessage(response.data);
    await sendMessage(sock, fromNumber, attendanceMessage);
    console.log("Sent attendance data back to user.");
  } catch (error) {
    console.error("Error fetching attendance data:", error);
    await sendMessage(
      sock,
      fromNumber,
      "Invalid roll number or password.\n\nFor help, click here: " +HELP_DOC_LINK
    );
  }
}

async function handleSetCommand(words, fromNumber, sock) {
  if (words.length < 4) {
    await sendMessage(
      sock,
      fromNumber,
      "Invalid format. Use: set <short_id> <roll_number> <password>\n\nFor help, click here: " +HELP_DOC_LINK
    );
    return;
  }
  const [_, shortId, rollNumber, password] = words;
  try {
    // Validate credentials via API call.
    await fetchAttendanceData(rollNumber, password);

    // Fetch existing user data.
    const userInfo = await dynamoDB
      .get({
        TableName: userTable,
        Key: { phoneNumber: fromNumber },
      })
      .promise();
    let userCredentials = userInfo.Item ? userInfo.Item.credentials || [] : [];

    const existingRollNumber = userCredentials.find(
      (cred) => cred.rollNumber === rollNumber
    );
    if (existingRollNumber) {
      await sendMessage(
        sock,
        fromNumber,
        `⚠️ This roll number is already linked to short form: ${existingRollNumber.shortId}\n\n` +
          `To delete it, type: delete ${existingRollNumber.shortId}\n\nFor help, click here: ` +
          HELP_DOC_LINK
      );
      return;
    }

    const existingShortId = userCredentials.find(
      (cred) => cred.shortId === shortId
    );
    if (existingShortId) {
      existingShortId.rollNumber = rollNumber;
      existingShortId.password = password;
      await sendMessage(
        sock,
        fromNumber,
        `Updated the short form ${shortId} with new roll number and password.`
      );
    } else {
      userCredentials.push({ shortId, rollNumber, password });
      await sendMessage(
        sock,
        fromNumber,
        `Short form saved: ${shortId}\n\nTo view all, type: shortforms`
      );
    }

    await dynamoDB
      .put({
        TableName: userTable,
        Item: { phoneNumber: fromNumber, credentials: userCredentials },
      })
      .promise();
  } catch (error) {
    console.error("Error validating credentials:", error);
    await sendMessage(
      sock,
      fromNumber,
      "Invalid roll number or password. Please try again."
    );
  }
}

async function handleShortFormRetrieval(shortId, fromNumber, sock) {
  const userInfo = await dynamoDB
    .get({
      TableName: userTable,
      Key: { phoneNumber: fromNumber },
    })
    .promise();
  if (userInfo.Item && userInfo.Item.credentials) {
    const matchingCredential = userInfo.Item.credentials.find(
      (cred) => cred.shortId === shortId
    );
    if (matchingCredential) {
      await handleDirectCommand(
        matchingCredential.rollNumber,
        matchingCredential.password,
        fromNumber,
        sock
      );
      return;
    }
  }
  await sendMessage(sock, fromNumber, "Short form not found.");
}

async function handleDeleteCommand(words, fromNumber, sock) {
  if (words.length < 2) {
    await sendMessage(
      sock,
      fromNumber,
      "Invalid format. Use: delete <short_id>\n\nFor help, click here: " +
        HELP_DOC_LINK
    );
    return;
  }
  const shortIdToDelete = words[1];
  const userInfo = await dynamoDB
    .get({
      TableName: userTable,
      Key: { phoneNumber: fromNumber },
    })
    .promise();

  if (
    userInfo.Item &&
    userInfo.Item.credentials &&
    userInfo.Item.credentials.length > 0
  ) {
    const updatedCredentials = userInfo.Item.credentials.filter(
      (cred) => cred.shortId !== shortIdToDelete
    );
    if (updatedCredentials.length < userInfo.Item.credentials.length) {
      await dynamoDB
        .put({
          TableName: userTable,
          Item: { phoneNumber: fromNumber, credentials: updatedCredentials },
        })
        .promise();
      await sendMessage(
        sock,
        fromNumber,
        `Short form ${shortIdToDelete} has been deleted.`
      );
    } else {
      await sendMessage(
        sock,
        fromNumber,
        `No short form found with the ID: ${shortIdToDelete}\n\nFor help, click here: ` +
          HELP_DOC_LINK
      );
    }
  } else {
    await sendMessage(
      sock,
      fromNumber,
      "You have no saved short forms to delete.\n\nFor help, click here: " +
        HELP_DOC_LINK
    );
  }
}

async function handleShowShortForms(fromNumber, sock) {
  const userInfo = await dynamoDB
    .get({
      TableName: userTable,
      Key: { phoneNumber: fromNumber },
    })
    .promise();
  if (
    userInfo.Item &&
    userInfo.Item.credentials &&
    userInfo.Item.credentials.length > 0
  ) {
    let shortformMessage = "Your Saved Short Forms:\n";
    userInfo.Item.credentials.forEach((cred) => {
      shortformMessage += `Short ID: ${cred.shortId} - Roll Number: ${cred.rollNumber}\n`;
    });
    shortformMessage +=
      `\nTo delete a short form, type: delete <short_id>\n\nFor help, click here: ` +
      HELP_DOC_LINK;
    await sendMessage(sock, fromNumber, shortformMessage);
  } else {
    await sendMessage(
      sock,
      fromNumber,
      "You have no saved short forms.\n\nFor help, click here: " + HELP_DOC_LINK
    );
  }
}

async function handleDefaultMessage(fromNumber, sock) {
  const helpText = `👋 *Hi there!*
  
🤖 *Welcome to the Attendance Bot* for our college.
  
*Method 1: Quick Data*
Send your *roll number* followed by your *password*.
_Example:_
\`22L31A0596 password\`
  
*Method 2: Short Form*
Save a short form for easier use.
To save, type:
\`set short_form roll_number password\`
_Example:_
\`set 596 22L31A0596 password\`
  
To delete a saved short form:
\`delete short_form_id\`
  
To view all saved short forms, type:
\`shortforms\`
  
For help, click here: ${HELP_DOC_LINK}
  
Enjoy! 😊`;
  await sendMessage(sock, fromNumber, helpText);
}

async function handleSkipCommand(words, fromNumber, sock) {
  try {
    const [command, hours] = words;
    const userInfo = await dynamoDB
      .get({
        TableName: userTable,
        Key: { phoneNumber: fromNumber },
      })
      .promise();

    if (userInfo.Item && userInfo.Item.credentials) {
      const { rollNumber, password } = userInfo.Item.credentials[0];
      const response = await axios.get(
        "https://a0qna69x15.execute-api.ap-southeast-2.amazonaws.com/dev/skip",{
          params: {
            student_id: rollNumber,
            password,
            hours
          }
        }
      );
      
      let message = `Attendance report after skipping ${hours} hours:\n\n`;

      message += `New attendance % : ${response.data.new_attendance_percentage}%\n`;
      message += `Original attendance % : ${response.data.original_attendance_percentage}%\n`;
      message += `${response.data.status}\n\n`;
      message += `Hours left to skip : ${response.data.hours_can_skip_after}\n`;

      await sendMessage(sock, fromNumber, message);
    }
  } catch (error) {
    console.log("Error handling skip command:", error);
  }
}

async function handleIncomingMessages(sock) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const message = messages[0];
    if (message.key.fromMe) return; // Ignore bot's own messages

    console.log("Received message:", message);
    const msgText =
      message.message?.conversation?.trim() ||
      message.message?.extendedTextMessage?.text?.trim();
    const fromNumber = message.key.remoteJid;
    if (!msgText) return;

    const words = msgText.split(" ");
    const command = words[0].toLowerCase();

    // If the message has two words and starts with a number, treat it as direct attendance input.
    if (words.length === 2 && /^[0-9]/.test(words[0])) {
      return await handleDirectCommand(words[0], words[1], fromNumber, sock);
    }

    // Command routing
    switch (command) {
      case "set":
        return await handleSetCommand(words, fromNumber, sock);
      case "delete":
        return await handleDeleteCommand(words, fromNumber, sock);
      case "shortforms":
        return await handleShowShortForms(fromNumber, sock);
      case "skip":
        return await handleSkipCommand(words, fromNumber, sock);
      case "logout":
        return await logout(sock);
      default:
        // If the command doesn't match any above, try to see if it's a short form retrieval.
        await handleShortFormRetrieval(msgText, fromNumber, sock);
        // If retrieval fails (i.e. no matching short form), send the default help message.
        return await handleDefaultMessage(fromNumber, sock);
    }
  });
}

async function init() {
  try {
    const sock = await whatsAppConnection();
    if (sock) {
      await handleIncomingMessages(sock);
    }
  } catch (err) {
    console.error("Error in initialization:", err);
  }
}

init();