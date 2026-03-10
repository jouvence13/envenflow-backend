export const storage = {
  async upload(_file: Buffer, fileName: string): Promise<{ url: string; path: string }> {
    return {
      url: `https://storage.example.com/${fileName}`,
      path: fileName
    };
  }
};
