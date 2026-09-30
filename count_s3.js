const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: 'garage', // or 'us-east-1'
  endpoint: 'https://storage.ui.activ.org.in',
  credentials: {
    accessKeyId: 'GK8164c24e3dfa0545b06a48ab',
    secretAccessKey: '973e1d0627c9775c346632431beec78a4ada4b135ee5fefceceaaf50951d96e5',
  },
  forcePathStyle: true, 
});

async function countFiles() {
  try {
    let isTruncated = true;
    let continuationToken;
    let count = 0;

    while (isTruncated) {
      const command = new ListObjectsV2Command({
        Bucket: 'activ',
        ContinuationToken: continuationToken,
      });

      const response = await s3Client.send(command);
      if (response.Contents) {
        count += response.Contents.length;
      }
      isTruncated = response.IsTruncated;
      continuationToken = response.NextContinuationToken;
    }

    console.log(`\n✅ There are exactly ${count} files/images currently stored in your S3 Bucket!`);
  } catch (error) {
    console.error("Error connecting to S3:", error.message);
  }
}

countFiles();
