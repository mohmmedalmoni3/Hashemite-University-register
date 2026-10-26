-- LOCAL/TEST DATABASE ONLY. This removes only rows made by registration-load-test.js.
DELETE FROM registrants
WHERE email LIKE 'ieee-loadtest-%@example.invalid';
