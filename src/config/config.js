const requiredEnvVars = [
    "MONGO_URI",
    "JWT_SECRET"
];

const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

if (missingEnvVars.length > 0) {
    console.warn(`⚠️ Warning: Missing critical environment variables: ${missingEnvVars.join(", ")}`);
    console.warn("Please check your .env file or environment configuration.");
}

module.exports = {
    env: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT, 10) || 3000,
    mongoose: {
        url: process.env.MONGO_URI,
    },
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        serviceSid: process.env.TWILIO_SERVICE_SID,
    },
    fast2sms: {
        apiKey: process.env.FAST2SMS_API_KEY,
    },
    razorpay: {
        keyId: process.env.RAZORPAY_KEY_ID,
        keySecret: process.env.RAZORPAY_KEY_SECRET,
        // Webhooks are signed with the secret set in Razorpay Dashboard > Webhooks,
        // which is separate from the API key secret.
        webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET
    },
    email: {
        smtp: {
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        },
        from: process.env.EMAIL_FROM || "noreply@mantrajyotish.com",
    }
};
