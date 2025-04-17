# WhatsApp Attendance Bot

A WhatsApp-based attendance tracking system for college students to quickly check their attendance, manage credentials, and simulate attendance changes.

## 🌟 Features

- **Instant Attendance Checking**: Get your attendance details directly via WhatsApp
- **Credential Management**: Save your roll number and password with easy-to-remember shortforms
- **Skip Simulation**: Calculate your attendance after hypothetically skipping classes
- **Today's Attendance**: Check which classes you attended today
- **Subject-wise Breakdown**: See attendance percentages for each subject
- **Total Attendance Overview**: Get your overall attendance percentage

## 📱 Usage Guide

### Method 1: Direct Roll Number and Password

Send your roll number and password directly:
```
22L31A0596 password123
```

### Method 2: Using Short Forms

#### Save credentials with a short form:
```
set 596 22L31A0596 password123
```

#### Check attendance using saved short form:
```
596
```

### Additional Commands

#### Check attendance after skipping hours:
```
skip 596 3
```
This shows how your attendance would look after skipping 3 hours

#### View all your saved short forms:
```
shortforms
```

#### Delete a saved short form:
```
delete 596
```

## 💾 Technical Information

### Architecture

- **Frontend**: WhatsApp messenger interface
- **Backend**: Node.js with [Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web API
- **Database**: AWS DynamoDB for credential and session storage
- **API**: RESTful API endpoints for attendance data retrieval

### DynamoDB Tables

1. **auth_info_baileys**: Stores WhatsApp authentication states
2. **user_info**: Stores user credentials and short forms

### Environment Requirements

- Node.js v14+
- AWS account with DynamoDB access
- Internet connectivity for WhatsApp Web

## 🔧 Setup for Developers

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Configure AWS credentials
4. Create required DynamoDB tables
5. Run the application:
   ```
   node index.js
   ```
6. Scan the QR code that appears in the terminal with WhatsApp

## 📋 Response Format

Attendance responses include:
- Student roll number
- Total attendance percentage
- Today's attendance record
- Skip information (hours you can safely skip)
- Subject-wise attendance details

## ⚠️ Troubleshooting

- **Authentication Issues**: Rescan the QR code if connection is lost
- **Invalid Credentials**: Double-check your roll number and password
- **API Connection Errors**: Ensure internet connectivity

## 🔐 Security Note

Your credentials are stored securely in AWS DynamoDB with limited access. The application only uses your credentials to fetch attendance data and does not share them with any third parties.

## 📚 Help Documentation

For detailed instructions and troubleshooting, refer to our [help documentation](https://docs.google.com/document/d/185hlWtDBe9BICEBXIqC2EsRZV0N_uBRgdiAjP0Zo2YE/edit?usp=sharing).

---

*Made with ❤️ for easy attendance tracking*
