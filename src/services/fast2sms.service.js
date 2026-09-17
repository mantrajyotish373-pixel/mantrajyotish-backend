const getConfig = () => {
    const apiKey = process.env.FAST2SMS_API_KEY;
    const useMockOtp = process.env.USE_MOCK_OTP === "true";
    const isConfigured = Boolean(!useMockOtp && apiKey && apiKey.length > 5 && apiKey !== "your_fast2sms_api_key");

    return {
        apiKey,
        isConfigured,
        templateName: process.env.FAST2SMS_WA_TEMPLATE_NAME || "whatsapp_otp",
        phoneNumberId: process.env.FAST2SMS_WA_PHONE_NUMBER_ID || "917830667337"
    };
};

/**
 * Standardize phone number for WhatsApp Fast2SMS API
 * Ensures 10-digit clean mobile number or full country code format if required.
 * @param {string} phone
 * @returns {string} 10 digit phone number
 */
const formatPhoneNumber = (phone) => {
    if (!phone) return "";
    let clean = String(phone).replace(/\D/g, "");
    if (clean.length > 10 && clean.startsWith("91")) {
        clean = clean.slice(-10);
    }
    return clean;
};

/**
 * Send OTP to phone number using Fast2SMS WhatsApp Business API
 * @param {string} phone - Mobile number (e.g. +919876543210 or 9876543210)
 * @param {string|number} otp - Numeric OTP code
 * @returns {Promise<{success: boolean, message: string, mock?: boolean, response?: any}>}
 */
const sendOtp = async (phone, otp) => {
    const config = getConfig();
    const cleanPhone = formatPhoneNumber(phone);

    if (!cleanPhone || cleanPhone.length !== 10) {
        throw new Error("Invalid mobile number format. A valid 10-digit mobile number is required.");
    }

    if (!config.isConfigured) {
        console.log(`[DEVELOPMENT MOCK FAST2SMS WHATSAPP] OTP for ${cleanPhone} is: ${otp}`);
        return {
            success: true,
            message: "WhatsApp OTP sent successfully (Development Mode)",
            mock: true,
            otp
        };
    }

    const otpStr = String(otp).trim();
    // Fast2SMS WhatsApp Business template message ID for 'whatsapp_otp'
    const messageId = process.env.FAST2SMS_WA_MESSAGE_ID || "33365";

    try {
        console.log(`📲 Sending WhatsApp OTP (${otpStr}) to ${cleanPhone} via Fast2SMS (Message ID: ${messageId})...`);

        // Fast2SMS WhatsApp API POST request
        const response = await fetch("https://www.fast2sms.com/dev/whatsapp", {
            method: "POST",
            headers: {
                "authorization": config.apiKey,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                message_id: messageId,
                numbers: cleanPhone,
                variables_values: otpStr
            })
        });

        const data = await response.json();

        if (!response.ok || !data || data.return === false) {
            const errMsg = Array.isArray(data.message) ? data.message.join(", ") : (data.message || `Fast2SMS WhatsApp API failed with status ${response.status}`);
            throw new Error(errMsg);
        }

        console.log(`✅ Fast2SMS WhatsApp OTP sent successfully to ${cleanPhone}. Request ID: ${data.request_id || "N/A"}`);
        return {
            success: true,
            message: "WhatsApp OTP sent successfully",
            response: data
        };
    } catch (error) {
        console.error("Fast2SMS WhatsApp sendOtp error:", error.message || error);
        throw new Error(error.message || "Failed to deliver WhatsApp OTP via Fast2SMS");
    }
};

module.exports = {
    sendOtp,
    formatPhoneNumber,
    isFast2SmsConfigured: () => getConfig().isConfigured
};
