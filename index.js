const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;

app.use(cors())

app.get('/api/classify', async (req, res) => {
  const name = req.query.name;
  if (!name) {
    return res.status(400).json({status: 400, message: "Bad Request"});
  }
  if (Array.isArray(name)) {
    return res.status(422).json({status: 422, message: "Unprocessable Entity"});
  }

  try {
    const response = await fetch(`https://api.genderize.io?name=${name}`);
    const data = await response.json();

    if (!data.gender || data.count === 0) {
      return res.status(400).json({"status": "error", "message": "No prediction available for the provided name"});
    }

    data.processed_at = new Date().toISOString();
    data.is_confident = data.probability >= 0.7 && data.count >= 100;
    data.sample_size = data.count;
    delete data.count;

    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({status: 502, message: "Bad Gateway"});
  }
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

