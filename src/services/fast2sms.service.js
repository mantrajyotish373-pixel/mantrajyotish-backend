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

    // Fast2SMS WhatsApp API endpoints & payloads
    // Endpoint 1: https://www.fast2sms.com/dev/whatsapp
    // Endpoint 2: https://www.fast2sms.com/dev/bulkV2 (route=wa or route=whatsapp)
    try {
        console.log(`📲 Sending WhatsApp OTP (${otpStr}) to ${cleanPhone} via Fast2SMS WhatsApp template '${config.templateName}'...`);

        // Attempt Fast2SMS WhatsApp POST payload
        const waPayload = {
            authorization: config.apiKey,
            phone_number_id: config.phoneNumberId,
            template_name: config.templateName,
            recipients: [cleanPhone],
            body_variables: [otpStr]
        };

        let response = await fetch("https://www.fast2sms.com/dev/whatsapp", {
            method: "POST",
            headers: {
                "authorization": config.apiKey,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(waPayload)
        });

        let data;
        const rawText = await response.text();
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            data = { raw: rawText };
        }

        // If endpoint 1 returned false or non-ok, try GET / bulkV2 route parameter fallback
        if (!response.ok || (data && data.return === false)) {
            console.warn(`[Fast2SMS WhatsApp POST Endpoint Warning] ${data.message || rawText}. Trying GET endpoint fallback...`);
            
            const url = new URL("https://www.fast2sms.com/dev/bulkV2");
            url.searchParams.append("authorization", config.apiKey);
            url.searchParams.append("route", "wa");
            url.searchParams.append("numbers", cleanPhone);
            url.searchParams.append("message", config.templateName);
            url.searchParams.append("variables_values", otpStr);

            const getResponse = await fetch(url.toString(), {
                method: "GET",
                headers: { "Accept": "application/json" }
            });

            const getRawText = await getResponse.text();
            let getData;
            try {
                getData = JSON.parse(getRawText);
            } catch (e) {
                getData = { raw: getRawText };
            }

            if (!getResponse.ok || (getData && getData.return === false)) {
                const errMsg = getData.message || data.message || `Fast2SMS API failed with status ${response.status} / ${getResponse.status}`;
                throw new Error(errMsg);
            }
            data = getData;
        }

        console.log(`✅ Fast2SMS WhatsApp OTP sent successfully to ${cleanPhone}.`);
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
