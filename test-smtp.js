const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: 'mail.activ.org.in',
    port: 465,
    secure: true,
    auth: {
        user: 'events@activ.org.in',
        pass: 'RXac69Ud3CTOX'
    }
});

transporter.verify(function (error, success) {
    if (error) {
        console.log("Error connecting to email server:", error);
    } else {
        console.log("Success! The email server is ready to take our messages.");
    }
});
