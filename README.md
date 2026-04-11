# Gender Classify API

A lightweight REST API that predicts the gender of a given name using the [Genderize.io](https://genderize.io) service. It enriches the response with a confidence flag, a sample size, and a timestamp for every request.

---

## Requirements

- [Node.js](https://nodejs.org) (v18 or later recommended)
- npm

---

## Setup & Installation

1. **Clone the repository**

   ```bash
   git clone <your-repo-url>
   cd <your-repo-folder>
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the server**

   ```bash
   node index.js
   ```

   The server will start on port `3000`. You should see:

   ```
   Example app listening on port 3000
   ```

4. **Make a request**

   Open your browser or use a tool like [Postman](https://www.postman.com) and visit:

   ```
   http://localhost:3000/api/classify?name=James
   ```
